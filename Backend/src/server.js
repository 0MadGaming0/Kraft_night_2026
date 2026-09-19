import "dotenv/config";
import crypto from "crypto";
import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { MongoClient } from "mongodb";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 5000);
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB || "loadngo";
// Supplier-submitted load records live in their own MongoDB database.
const SUPPLIER_LOAD_DB_NAME = process.env.SUPPLIER_LOAD_DB || "suppliers_load";
const DEMO_MODE = process.env.DEMO_MODE !== "false";
const TWO_FACTOR_API_KEY = process.env.TWO_FACTOR_API_KEY;
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
const LOCATION_FRESH_MS = 2 * 60 * 1000;
const SEARCH_RADIUS_METERS = 100_000;

// ── Firebase Admin init ───────────────────────────────────────────────────────
let firebaseAuth = null;
if (FIREBASE_PROJECT_ID) {
    try {
        let credential;
        // Prefer inline env vars (no JSON file needed)
        if (process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
            credential = cert({
                projectId: FIREBASE_PROJECT_ID,
                clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                // Env vars escape newlines as \n — restore them
                privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n")
            });
            console.log("Firebase Admin: using inline env var credentials.");
        } else {
            // Fall back to the JSON service account file
            const rawPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || "./firebase-service-account (2).json";
            const credPath = path.isAbsolute(rawPath) ? rawPath : path.resolve(__dirname, "../", rawPath);
            if (fs.existsSync(credPath)) {
                const serviceAccount = JSON.parse(fs.readFileSync(credPath, "utf8"));
                credential = cert(serviceAccount);
                console.log(`Firebase Admin: using service account file (${credPath}).`);
            } else {
                throw new Error(`Service account file not found at ${credPath}`);
            }
        }
        const adminApp = getApps().length === 0
            ? initializeApp({ credential, projectId: FIREBASE_PROJECT_ID })
            : getApps()[0];
        firebaseAuth = getAuth(adminApp);
        console.log(`Firebase Admin: connected to project "${FIREBASE_PROJECT_ID}".`);
    } catch (error) {
        console.warn("Firebase Admin: could not initialise —", error.message);
        console.warn("Supplier auth will fall back to demo password mode.");
    }
} else {
    console.log("Firebase Admin: FIREBASE_PROJECT_ID not set — supplier auth uses demo password mode.");
}

const app = express();
app.use(express.json({ limit: "50kb" }));
app.use((req, res, next) => {
    res.set({
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type,X-Session-Id"
    });
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
});

const sessions = new Map();
const otpSessions = new Map();
const memory = { users: [], drivers: [], suppliers: [], loads: [], assignments: [], supplierLoads: [] };
let client;
let db;
let supplierLoadDb;

const id = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const clone = (value) => JSON.parse(JSON.stringify(value));
const point = (longitude, latitude) => ({ type: "Point", coordinates: [longitude, latitude] });
const serialise = (document) => {
    if (!document) return null;
    const { _id, ...rest } = document;
    return { ...rest, id: document.id || _id?.toString() };
};

function publicUser(user) {
    return {
        id: user.id,
        firebaseUid: user.firebaseUid,
        role: user.role,
        name: user.name,
        email: user.email || null,
        phone: user.phone || null
    };
}

function normalizePhone(phoneNumber) {
    if (typeof phoneNumber !== "string") return null;
    const phone = phoneNumber.trim().replace(/\s+/g, "");
    const normalized = phone.startsWith("+") ? phone : `+${phone}`;
    return /^\+\d{10,15}$/.test(normalized) ? normalized : null;
}

function validPoint(value) {
    const coordinates = value?.coordinates;
    if (!Array.isArray(coordinates) || coordinates.length !== 2) return false;
    const [longitude, latitude] = coordinates.map(Number);
    return Number.isFinite(longitude) && Number.isFinite(latitude)
        && longitude >= -180 && longitude <= 180
        && latitude >= -90 && latitude <= 90;
}

function kilometresBetween(from, to) {
    const [longitude1, latitude1] = from.coordinates;
    const [longitude2, latitude2] = to.coordinates;
    const radians = (degrees) => degrees * Math.PI / 180;
    const latitudeDelta = radians(latitude2 - latitude1);
    const longitudeDelta = radians(longitude2 - longitude1);
    const a = Math.sin(latitudeDelta / 2) ** 2
        + Math.cos(radians(latitude1)) * Math.cos(radians(latitude2))
        * Math.sin(longitudeDelta / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function connectStore() {
    if (!MONGODB_URI) {
        console.log("Database: in-memory demo store (set MONGODB_URI for MongoDB).");
        await ensureDemoSupplier();
        return;
    }
    client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 6000 });
    await client.connect();
    db = client.db(DB_NAME);
    supplierLoadDb = client.db(SUPPLIER_LOAD_DB_NAME);
    await Promise.all([
        db.collection("users").createIndex({ firebaseUid: 1 }, { unique: true }),
        db.collection("users").createIndex({ email: 1 }, { unique: true, sparse: true }),
        db.collection("drivers").createIndex({ firebaseUid: 1 }, { unique: true }),
        db.collection("drivers").createIndex({ currentLocation: "2dsphere" }),
        db.collection("suppliers").createIndex({ firebaseUid: 1 }, { unique: true }),
        db.collection("loads").createIndex({ supplierId: 1, createdAt: -1 }),
        db.collection("assignments").createIndex({ driverId: 1, status: 1 }),
        db.collection("assignments").createIndex({ loadId: 1, driverId: 1 }, { unique: true }),
        supplierLoadDb.collection("loads").createIndex({ firebaseUid: 1 }),
        supplierLoadDb.collection("loads").createIndex({ companyName: 1 })
    ]);
    await ensureDemoSupplier();
    console.log(`Database: MongoDB (${DB_NAME}); supplier records: ${SUPPLIER_LOAD_DB_NAME}.loads.`);
}

async function getById(collection, value) {
    if (db) return serialise(await db.collection(collection).findOne({ id: value }));
    return clone(memory[collection].find((item) => item.id === value) || null);
}

async function findOne(collection, query) {
    if (db) return serialise(await db.collection(collection).findOne(query));
    const entry = memory[collection].find((item) => Object.entries(query)
        .every(([key, value]) => item[key] === value));
    return clone(entry || null);
}

async function insert(collection, document) {
    const value = { ...clone(document), id: document.id || id() };
    if (db) await db.collection(collection).insertOne(value);
    else memory[collection].push(value);
    return clone(value);
}

async function updateById(collection, documentId, patch) {
    if (db) {
        await db.collection(collection).updateOne({ id: documentId }, { $set: clone(patch) });
        return getById(collection, documentId);
    }
    const index = memory[collection].findIndex((item) => item.id === documentId);
    if (index === -1) return null;
    memory[collection][index] = { ...memory[collection][index], ...clone(patch) };
    return clone(memory[collection][index]);
}

async function deleteById(collection, documentId) {
    if (db) {
        await db.collection(collection).deleteOne({ id: documentId });
        return true;
    }
    const index = memory[collection].findIndex((item) => item.id === documentId);
    if (index === -1) return false;
    memory[collection].splice(index, 1);
    return true;
}

async function deleteMany(collection, query) {
    if (db) {
        await db.collection(collection).deleteMany(query);
        return true;
    }
    memory[collection] = memory[collection].filter((item) =>
        !Object.entries(query).every(([key, value]) => item[key] === value)
    );
    return true;
}

// These records are separate from the matching loads collection. The
// suppliers_load database stores supplier records indexed by company name and firebase identity,
// containing companyName, total load quantity, and an array of loads.
// If a supplier record already exists, it is edited/updated; otherwise a new one is created.
async function saveSupplierLoadRecord(record) {
    const { firebaseUid, supplierId, companyName, load, currency } = record;
    const quantityKg = load?.quantityKg || 0;

    if (supplierLoadDb) {
        const collection = supplierLoadDb.collection("loads");
        const query = firebaseUid ? { $or: [{ firebaseUid }, { companyName }] } : { companyName };
        const existing = await collection.findOne(query);

        if (existing) {
            const newLoadQuantity = (existing.loadQuantity || 0) + quantityKg;
            const existingLoads = Array.isArray(existing.loads) ? existing.loads : (existing.load ? [existing.load] : []);
            const updatedLoads = [...existingLoads, load];

            await collection.updateOne(
                { _id: existing._id },
                {
                    $set: {
                        companyName,
                        loadQuantity: newLoadQuantity,
                        loads: updatedLoads,
                        updatedAt: now()
                    }
                }
            );
            return serialise({ ...existing, companyName, loadQuantity: newLoadQuantity, loads: updatedLoads, updatedAt: now() });
        } else {
            const value = {
                id: id(),
                firebaseUid: firebaseUid || null,
                supplierId,
                companyName,
                loadQuantity: quantityKg,
                loads: [load],
                currency,
                status: "SEARCHING",
                createdAt: now(),
                updatedAt: now()
            };
            await collection.insertOne(value);
            return serialise(value);
        }
    } else {
        const existingIndex = memory.supplierLoads.findIndex(
            (item) => (firebaseUid && item.firebaseUid === firebaseUid) || item.companyName === companyName
        );
        if (existingIndex !== -1) {
            const existing = memory.supplierLoads[existingIndex];
            existing.companyName = companyName;
            existing.loadQuantity = (existing.loadQuantity || 0) + quantityKg;
            if (!Array.isArray(existing.loads)) {
                existing.loads = existing.load ? [existing.load] : [];
            }
            existing.loads.push(load);
            existing.updatedAt = now();
            return clone(existing);
        } else {
            const value = {
                id: id(),
                firebaseUid: firebaseUid || null,
                supplierId,
                companyName,
                loadQuantity: quantityKg,
                loads: [load],
                currency,
                status: "SEARCHING",
                createdAt: now(),
                updatedAt: now()
            };
            memory.supplierLoads.push(value);
            return clone(value);
        }
    }
}

async function updateSupplierLoadRecord(loadId, patch) {
    if (supplierLoadDb) {
        const collection = supplierLoadDb.collection("loads");
        await collection.updateOne(
            { "loads.loadId": loadId },
            { $set: { "loads.$.status": patch.status, updatedAt: now(), ...clone(patch) } }
        );
        await collection.updateOne(
            { "load.loadId": loadId },
            { $set: clone(patch) }
        );
        return;
    }
    const record = memory.supplierLoads.find((item) =>
        (Array.isArray(item.loads) && item.loads.some((l) => l.loadId === loadId)) || item.load?.loadId === loadId
    );
    if (record) {
        if (Array.isArray(record.loads)) {
            const targetLoad = record.loads.find((l) => l.loadId === loadId);
            if (targetLoad) Object.assign(targetLoad, clone(patch));
        }
        Object.assign(record, clone(patch));
    }
}

async function removeSupplierLoad(loadId) {
    if (supplierLoadDb) {
        const collection = supplierLoadDb.collection("loads");
        await collection.updateOne(
            { "loads.loadId": loadId },
            { $pull: { loads: { loadId } }, $set: { updatedAt: now() } }
        );
        return;
    }
    const record = memory.supplierLoads.find((item) =>
        Array.isArray(item.loads) && item.loads.some((l) => l.loadId === loadId)
    );
    if (record && Array.isArray(record.loads)) {
        record.loads = record.loads.filter((l) => l.loadId !== loadId);
        record.updatedAt = now();
    }
}

async function supplierLoadRecords(firebaseUid) {
    if (supplierLoadDb) {
        const records = await supplierLoadDb.collection("loads")
            .find(firebaseUid ? { firebaseUid } : {})
            .sort({ updatedAt: -1, createdAt: -1 })
            .toArray();
        return records.map(serialise);
    }
    return clone(memory.supplierLoads
        .filter((record) => !firebaseUid || record.firebaseUid === firebaseUid)
        .sort((left, right) => (right.updatedAt || right.createdAt).localeCompare(left.updatedAt || left.createdAt)));
}

async function ensureDemoSupplier() {
    const email = "supplier@coload.demo";
    const existing = await findOne("users", { email });
    if (existing) return existing;
    const user = await insert("users", {
        firebaseUid: `demo-supplier-${id()}`,
        role: "supplier",
        name: "ABC Logistics",
        email,
        password: "123456",
        createdAt: now()
    });
    await insert("suppliers", {
        firebaseUid: user.firebaseUid,
        userId: user.id,
        companyName: user.name,
        createdAt: now()
    });
    return user;
}

async function upsertDriverUser({ name, phone }) {
    let user = await findOne("users", { phone });
    if (!user) {
        user = await insert("users", {
            firebaseUid: `driver-${id()}`,
            role: "driver",
            name,
            phone,
            createdAt: now()
        });
    } else if (user.name !== name) {
        user = await updateById("users", user.id, { name });
    }
    let driver = await findOne("drivers", { firebaseUid: user.firebaseUid });
    if (!driver) {
        driver = await insert("drivers", {
            firebaseUid: user.firebaseUid,
            userId: user.id,
            name: user.name,
            phone,
            verified: true,
            available: true,
            vehicle: { type: "Mini Truck", capacityKg: 15000 },
            currentLocation: null,
            locationAccuracy: null,
            lastLocationUpdate: null,
            createdAt: now()
        });
    } else {
        driver = await updateById("drivers", driver.id, { name: user.name, verified: true });
    }
    return { user, driver };
}

async function createSupplier({ companyName, email, password, firebaseUid }) {
    if (await findOne("users", { email })) throw new Error("An account already exists for this email.");
    const uid = firebaseUid || `supplier-${id()}`;
    const user = await insert("users", {
        firebaseUid: uid,
        role: "supplier",
        name: companyName,
        email,
        ...(password ? { password } : {}),
        createdAt: now()
    });
    await insert("suppliers", {
        firebaseUid: uid,
        userId: user.id,
        companyName,
        createdAt: now()
    });
    return user;
}

// Verify a Firebase ID token and return the decoded token payload.
async function verifyFirebaseToken(idToken) {
    if (!firebaseAuth) throw new Error("Firebase is not configured on this server.");
    return firebaseAuth.verifyIdToken(idToken);
}

// Find or create a supplier user record from a verified Firebase token.
async function upsertSupplierFromFirebase(decoded) {
    const { uid, email, name } = decoded;
    let user = await findOne("users", { firebaseUid: uid });
    if (!user && email) {
        user = await findOne("users", { email });
        if (user) {
            user = await updateById("users", user.id, { firebaseUid: uid });
            const supplier = (await findOne("suppliers", { firebaseUid: uid })) || (await findOne("suppliers", { userId: user.id }));
            if (supplier) {
                await updateById("suppliers", supplier.id, { firebaseUid: uid });
            } else {
                await insert("suppliers", { firebaseUid: uid, userId: user.id, companyName: user.name || "Supplier", createdAt: now() });
            }
        }
    }
    if (!user) {
        // First time — auto-create using email prefix as company name placeholder.
        const companyName = name || (email ? email.split("@")[0] : "Supplier");
        user = await insert("users", {
            firebaseUid: uid,
            role: "supplier",
            name: companyName,
            ...(email ? { email } : {}),
            createdAt: now()
        });
        await insert("suppliers", {
            firebaseUid: uid,
            userId: user.id,
            companyName,
            createdAt: now()
        });
    }
    return user;
}

// Pre-warm the local Ollama model in the background
function prewarmModel() {
    fetch("http://127.0.0.1:11434/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "qwen3:4b", keep_alive: "5m" })
    }).catch(() => { }); // Fire and forget, don't crash if it fails
}

function createSession(user) {
    const sessionId = crypto.randomBytes(32).toString("hex");
    sessions.set(sessionId, { userId: user.id, createdAt: Date.now() });
    prewarmModel();
    return sessionId;
}

async function requireActor(req, res, roles) {
    const session = sessions.get(req.header("x-session-id"));
    if (!session) {
        res.status(401).json({ success: false, message: "Please sign in to continue." });
        return null;
    }
    const user = await getById("users", session.userId);
    if (!user || (roles && !roles.includes(user.role))) {
        res.status(403).json({ success: false, message: "You do not have access to this action." });
        return null;
    }
    return user;
}

async function sendOtp(phoneNumber) {
    if (DEMO_MODE || !TWO_FACTOR_API_KEY) {
        const code = "123456";
        otpSessions.set(phoneNumber, { code, createdAt: Date.now(), demo: true });
        return { demoCode: DEMO_MODE ? code : undefined };
    }
    const response = await fetch(
        `https://2factor.in/API/V1/${TWO_FACTOR_API_KEY}/SMS/${phoneNumber.slice(1)}/AUTOGEN`,
        { signal: AbortSignal.timeout(15000) }
    );
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.Status !== "Success") throw new Error("2Factor could not send the OTP.");
    otpSessions.set(phoneNumber, { sessionId: data.Details, createdAt: Date.now(), demo: false });
    return {};
}

async function verifyOtp(phoneNumber, code) {
    const session = otpSessions.get(phoneNumber);
    if (!session || Date.now() - session.createdAt > 5 * 60 * 1000) {
        otpSessions.delete(phoneNumber);
        throw new Error("OTP session expired. Request a new code.");
    }
    if (session.demo) {
        if (code !== session.code) throw new Error("That OTP is not valid.");
    } else {
        const response = await fetch(
            `https://2factor.in/API/V1/${TWO_FACTOR_API_KEY}/SMS/VERIFY/${encodeURIComponent(session.sessionId)}/${encodeURIComponent(code)}`,
            { signal: AbortSignal.timeout(15000) }
        );
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.Status !== "Success") throw new Error("That OTP is not valid.");
    }
    otpSessions.delete(phoneNumber);
}

function driverSummary(driver, distanceMeters) {
    return {
        id: driver.id,
        name: driver.name,
        vehicle: driver.vehicle,
        distanceKm: Number((distanceMeters / 1000).toFixed(1)),
        locationAccuracy: driver.locationAccuracy,
        lastLocationUpdate: driver.lastLocationUpdate
    };
}

async function eligibleDrivers(load) {
    const threshold = new Date(Date.now() - LOCATION_FRESH_MS).toISOString();
    const pickup = load.pickup.location;
    if (db) {
        const results = await db.collection("drivers").aggregate([
            {
                $geoNear: {
                    near: pickup,
                    key: "currentLocation",
                    distanceField: "distanceMeters",
                    maxDistance: SEARCH_RADIUS_METERS,
                    query: {
                        verified: true,
                        available: true,
                        "vehicle.capacityKg": { $gte: load.quantityKg },
                        lastLocationUpdate: { $gte: threshold }
                    }
                }
            },
            { $limit: 10 }
        ]).toArray();
        return results.map((driver) => driverSummary(serialise(driver), driver.distanceMeters));
    }
    return memory.drivers
        .filter((driver) => driver.verified && driver.available && driver.currentLocation
            && driver.vehicle.capacityKg >= load.quantityKg
            && driver.lastLocationUpdate >= threshold)
        .map((driver) => ({ driver, distanceMeters: kilometresBetween(pickup, driver.currentLocation) * 1000 }))
        .filter(({ distanceMeters }) => distanceMeters <= SEARCH_RADIUS_METERS)
        .sort((a, b) => a.distanceMeters - b.distanceMeters)
        .slice(0, 10)
        .map(({ driver, distanceMeters }) => driverSummary(driver, distanceMeters));
}

async function loadForSupplier(loadId, supplierId) {
    const load = await getById("loads", loadId);
    return load?.supplierId === supplierId ? load : null;
}

async function supplierLoadList(supplierId) {
    const loads = db
        ? await db.collection("loads").find({ supplierId }).sort({ createdAt: -1 }).toArray().then((items) => items.map(serialise))
        : clone(memory.loads.filter((load) => load.supplierId === supplierId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    return Promise.all(loads.map(async (load) => {
        // 1. Check for ACCEPTED assignment first
        let assignment = db
            ? serialise(await db.collection("assignments").findOne({ loadId: load.id, status: "ACCEPTED" }))
            : clone(memory.assignments.find((item) => item.loadId === load.id && item.status === "ACCEPTED") || null);

        // 2. Then check for OFFERED assignment
        if (!assignment) {
            assignment = db
                ? serialise(await db.collection("assignments").findOne({ loadId: load.id, status: "OFFERED" }))
                : clone(memory.assignments.find((item) => item.loadId === load.id && item.status === "OFFERED") || null);
        }

        // 3. Then check for latest REJECTED assignment
        if (!assignment) {
            assignment = db
                ? serialise(await db.collection("assignments").findOne({ loadId: load.id, status: "REJECTED" }, { sort: { createdAt: -1 } }))
                : clone(memory.assignments.filter((item) => item.loadId === load.id && item.status === "REJECTED").sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""))[0] || null);
        }

        let driverInfo = null;
        if (assignment?.driverId) {
            const driver = await getById("drivers", assignment.driverId);
            if (driver) {
                driverInfo = {
                    id: driver.id,
                    name: driver.name,
                    phone: driver.phone,
                    vehicle: driver.vehicle,
                    distanceKm: assignment.distanceKm,
                    lastLocationUpdate: driver.lastLocationUpdate
                };
            }
        }

        const isRejected = assignment?.status === "REJECTED" || load.status === "REJECTED";

        return { ...load, assignment, driverInfo, isRejected };
    }));
}

async function driverJobs(driverId) {
    // 1. Get existing assignments for this driver
    const assignments = db
        ? await db.collection("assignments").find({ driverId, status: { $in: ["OFFERED", "ACCEPTED"] } }).sort({ createdAt: -1 }).toArray().then((items) => items.map(serialise))
        : clone(memory.assignments.filter((item) => item.driverId === driverId && ["OFFERED", "ACCEPTED"].includes(item.status)));

    // 2. Find the driver record to check location + capacity
    const driver = await getById("drivers", driverId);
    if (driver && driver.currentLocation && driver.available) {
        // 3. Find all loads that are SEARCHING or OFFERED and near this driver
        const allLoads = db
            ? await db.collection("loads").find({ status: { $in: ["SEARCHING", "OFFERED"] } }).toArray().then((items) => items.map(serialise))
            : clone(memory.loads.filter((l) => ["SEARCHING", "OFFERED"].includes(l.status)));

        const assignedLoadIds = new Set(assignments.map((a) => a.loadId));
        for (const load of allLoads) {
            if (load.status !== "SEARCHING") continue;
            if (assignedLoadIds.has(load.id)) continue; // already have an assignment
            if (load.quantityKg > driver.vehicle.capacityKg) continue; // too heavy
            if (!load.pickup?.location || !validPoint(load.pickup.location)) continue;
            const distKm = kilometresBetween(driver.currentLocation, load.pickup.location);
            if (distKm > SEARCH_RADIUS_METERS / 1000) continue; // too far

            // Auto-create an OFFERED assignment so the driver can accept/reject
            const existing = db
                ? serialise(await db.collection("assignments").findOne({ loadId: load.id, driverId }))
                : memory.assignments.find((a) => a.loadId === load.id && a.driverId === driverId) || null;
            if (existing) continue; // already has an assignment (maybe REJECTED)

            const assignment = await insert("assignments", {
                loadId: load.id, driverId, distanceKm: Number(distKm.toFixed(1)),
                status: "OFFERED", createdAt: now()
            });
            await updateById("loads", load.id, { status: "OFFERED" });
            await updateSupplierLoadRecord(load.id, { status: "OFFERED", assignmentId: assignment.id, offeredDriverId: driverId, updatedAt: now() });

            assignments.push(assignment);
        }
    }

    return Promise.all(assignments.map(async (assignment) => {
        const load = await getById("loads", assignment.loadId);
        if (load && load.supplierId) {
            const supplierUser = await getById("users", load.supplierId);
            const supplier = await findOne("suppliers", { userId: load.supplierId });
            if (supplierUser) {
                load.supplierPhone = supplierUser.phone || null;
                load.supplierEmail = supplierUser.email || null;
            }
            if (supplier) {
                load.supplierCompany = supplier.companyName || supplierUser?.name || "Unknown";
                load.supplierRegistration = `REG-${(supplier.userId || supplier.id || "00000000").substring(0, 8).toUpperCase()}`;
                load.supplierStatus = "Verified Business";
                load.legalDisclaimer = "This supplier is verified. Goods transported are declared legal and comply with transport regulations.";
            }
        }
        return { ...assignment, load };
    }));
}

app.get("/api/health", (req, res) => res.json({ success: true, dataStore: db ? "mongodb" : "memory", demoMode: DEMO_MODE }));

app.post("/api/auth/driver/send-otp", async (req, res, next) => {
    try {
        const phone = normalizePhone(req.body.phoneNumber);
        if (!phone) return res.status(400).json({ success: false, message: "Use a valid phone number, for example +919876543210." });
        res.json({ success: true, message: "OTP sent successfully.", ...(await sendOtp(phone)) });
    } catch (error) { next(error); }
});

app.post("/api/auth/driver/verify-otp", async (req, res, next) => {
    try {
        const phone = normalizePhone(req.body.phoneNumber);
        const name = String(req.body.name || "").trim();
        const otp = String(req.body.otp || "").trim();
        if (!phone || !name || !/^\d{6}$/.test(otp)) return res.status(400).json({ success: false, message: "Enter your name, phone number, and 6-digit OTP." });
        await verifyOtp(phone, otp);
        const { user } = await upsertDriverUser({ name, phone });
        res.json({ success: true, sessionId: createSession(user), user: publicUser(user) });
    } catch (error) { next(error); }
});

// ── Supplier auth via Firebase ID token (primary path when Firebase is configured)
app.post("/api/auth/supplier/firebase-verify", async (req, res, next) => {
    try {
        const idToken = String(req.body.idToken || "").trim();
        if (!idToken) return res.status(400).json({ success: false, message: "Firebase ID token is required." });
        const decoded = await verifyFirebaseToken(idToken);
        const user = await upsertSupplierFromFirebase(decoded);
        res.json({ success: true, sessionId: createSession(user), user: publicUser(user) });
    } catch (error) { next(error); }
});

// ── Supplier registration with company name (called after Firebase creates the account)
app.post("/api/auth/supplier/firebase-register", async (req, res, next) => {
    try {
        const idToken = String(req.body.idToken || "").trim();
        const companyName = String(req.body.companyName || "").trim();
        if (!idToken || !companyName) return res.status(400).json({ success: false, message: "ID token and company name are required." });
        const decoded = await verifyFirebaseToken(idToken);
        // Check if user already exists — if so, just update the company name.
        let user = await findOne("users", { firebaseUid: decoded.uid });
        if (!user && decoded.email) {
            user = await findOne("users", { email: decoded.email });
        }
        if (user) {
            user = await updateById("users", user.id, { firebaseUid: decoded.uid, name: companyName, ...(decoded.email ? { email: decoded.email } : {}) });
            const existingSupplier = (await findOne("suppliers", { firebaseUid: decoded.uid })) || (await findOne("suppliers", { userId: user.id }));
            if (existingSupplier) {
                await updateById("suppliers", existingSupplier.id, { firebaseUid: decoded.uid, companyName });
            } else {
                await insert("suppliers", { firebaseUid: decoded.uid, userId: user.id, companyName, createdAt: now() });
            }
        } else {
            user = await insert("users", {
                firebaseUid: decoded.uid,
                role: "supplier",
                name: companyName,
                ...(decoded.email ? { email: decoded.email } : {}),
                createdAt: now()
            });
            await insert("suppliers", { firebaseUid: decoded.uid, userId: user.id, companyName, createdAt: now() });
        }
        res.status(201).json({ success: true, sessionId: createSession(user), user: publicUser(user) });
    } catch (error) { next(error); }
});

// ── Supplier demo/fallback login (used when FIREBASE_PROJECT_ID is not set)
app.post("/api/auth/supplier/register", async (req, res, next) => {
    try {
        if (firebaseAuth) return res.status(400).json({ success: false, message: "Use Firebase sign-up on the frontend." });
        const companyName = String(req.body.companyName || "").trim();
        const email = String(req.body.email || "").trim().toLowerCase();
        const password = String(req.body.password || "");
        if (!companyName || !/^\S+@\S+\.\S+$/.test(email) || password.length < 6) return res.status(400).json({ success: false, message: "Provide a company name, valid email, and password with at least 6 characters." });
        const user = await createSupplier({ companyName, email, password });
        res.status(201).json({ success: true, sessionId: createSession(user), user: publicUser(user) });
    } catch (error) { next(error); }
});

app.post("/api/auth/supplier/login", async (req, res, next) => {
    try {
        if (firebaseAuth) return res.status(400).json({ success: false, message: "Use Firebase sign-in on the frontend." });
        const email = String(req.body.email || "").trim().toLowerCase();
        const password = String(req.body.password || "");
        const user = await findOne("users", { email });
        if (!user || user.role !== "supplier" || user.password !== password) return res.status(401).json({ success: false, message: "Email or password is incorrect." });
        res.json({ success: true, sessionId: createSession(user), user: publicUser(user) });
    } catch (error) { next(error); }
});

app.get("/api/auth/session", async (req, res) => {
    const user = await requireActor(req, res);
    if (user) {
        prewarmModel();
        res.json({ success: true, user: publicUser(user) });
    }
});

app.post("/api/driver/location", async (req, res) => {
    const user = await requireActor(req, res, ["driver"]);
    if (!user) return;
    const longitude = Number(req.body.longitude);
    const latitude = Number(req.body.latitude);
    const location = point(longitude, latitude);
    if (!validPoint(location)) return res.status(400).json({ success: false, message: "A valid GPS coordinate is required." });
    const driver = await findOne("drivers", { firebaseUid: user.firebaseUid });
    await updateById("drivers", driver.id, {
        currentLocation: location,
        locationAccuracy: Number.isFinite(Number(req.body.accuracy)) ? Math.round(Number(req.body.accuracy)) : null,
        lastLocationUpdate: now()
    });
    res.json({ success: true, message: "Live location updated." });
});

app.post("/api/driver/availability", async (req, res) => {
    const user = await requireActor(req, res, ["driver"]);
    if (!user) return;
    if (typeof req.body.available !== "boolean") return res.status(400).json({ success: false, message: "Availability must be true or false." });
    const driver = await findOne("drivers", { firebaseUid: user.firebaseUid });
    res.json({ success: true, driver: await updateById("drivers", driver.id, { available: req.body.available }) });
});

app.get("/api/driver/jobs", async (req, res) => {
    const user = await requireActor(req, res, ["driver"]);
    if (!user) return;
    const driver = await findOne("drivers", { firebaseUid: user.firebaseUid });
    res.json({ success: true, driver, jobs: await driverJobs(driver.id) });
});

app.post("/api/driver/know-more", async (req, res) => {
    const user = await requireActor(req, res, ["driver"]);
    if (!user) return;

    const loadId = req.body.loadId;
    if (!loadId) return res.status(400).json({ success: false, message: "Load ID is required." });

    const load = await getById("loads", loadId);
    if (!load) return res.status(404).json({ success: false, message: "Load not found." });

    const supplier = await findOne("suppliers", { userId: load.supplierId });
    if (!supplier) return res.status(404).json({ success: false, message: "Supplier not found." });

    const prompt = `Analyze this supplier and load data:
Supplier: ${supplier.companyName}
Registered: ${supplier.createdAt}
Goods: ${load.goodsType} (${load.quantityKg} kg)
Destination: ${load.destination}

Provide a concise summary (max 4 sentences) verifying the driver's legal security. Explicitly state that the driver is not responsible for the load's legality or any suspicious features. Point out any legal clauses the driver might have missed to prevent criminal charges.`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    try {
        const response = await fetch("http://127.0.0.1:11434/api/generate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model: "qwen3:4b",
                prompt,
                think: false,
                stream: false
            }),
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) throw new Error(`Ollama returned status ${response.status}`);
        const data = await response.json();

        // Strip any <think>...</think> block qwen3 may still emit
        const summary = (data.response || "")
            .replace(/<think>[\s\S]*?<\/think>/gi, "")
            .trim();

        res.json({ success: true, summary });
    } catch (error) {
        clearTimeout(timeoutId);
        console.error("Ollama error:", error.name, error.message);
        res.status(500).json({
            success: false,
            message: `Ollama failed: ${error.message}`
        });
    }
});

app.post("/api/supplier/load", async (req, res) => {
    const user = await requireActor(req, res, ["supplier"]);
    if (!user) return;
    const goodsType = String(req.body.goodsType || "").trim();
    const quantityKg = Number(req.body.quantityKg);
    const destination = String(req.body.destination || "").trim();
    const currency = String(req.body.currency || "INR").trim().toUpperCase();
    const currencyAmount = Number(req.body.currencyAmount);
    const requiredAt = new Date(req.body.requiredAt);
    const pickupLocation = req.body.pickup?.location;
    if (!goodsType || !Number.isFinite(quantityKg) || quantityKg <= 0 || !destination
        || !/^[A-Z]{3}$/.test(currency) || !Number.isFinite(currencyAmount) || currencyAmount <= 0
        || Number.isNaN(requiredAt.getTime()) || !validPoint(pickupLocation)) {
        return res.status(400).json({ success: false, message: "Complete goods, quantity, pickup, destination, currency, amount, and required time." });
    }

    const supplier = await findOne("suppliers", { firebaseUid: user.firebaseUid });
    const companyName = supplier?.companyName || user.name;
    const loadId = id();
    const loadPayload = {
        loadId,
        goodsType,
        quantityKg: Math.round(quantityKg),
        pickup: { location: point(...pickupLocation.coordinates) },
        destination,
        requiredAt: requiredAt.toISOString()
    };
    const supplierLoadRecord = await saveSupplierLoadRecord({
        firebaseUid: user.firebaseUid,
        supplierId: user.id,
        companyName,
        currency: { code: currency, amount: Number(currencyAmount.toFixed(2)) },
        load: loadPayload,
        status: "SEARCHING",
        createdAt: now()
    });
    const load = await insert("loads", {
        id: loadId,
        supplierId: user.id,
        firebaseUid: user.firebaseUid,
        companyName,
        currency,
        currencyAmount: Number(currencyAmount.toFixed(2)),
        ...loadPayload,
        supplierLoadRecordId: supplierLoadRecord.id,
        status: "SEARCHING",
        createdAt: now()
    });

    // Auto-match and offer to closest driver if available
    const candidates = await eligibleDrivers(load);
    if (candidates.length > 0) {
        const candidate = candidates[0];
        const assignment = await insert("assignments", { loadId: load.id, driverId: candidate.id, distanceKm: candidate.distanceKm, status: "OFFERED", createdAt: now() });
        await updateById("loads", load.id, { status: "OFFERED" });
        await updateSupplierLoadRecord(load.id, { status: "OFFERED", assignmentId: assignment.id, offeredDriverId: candidate.id, updatedAt: now() });
        load.status = "OFFERED"; // update for response
    } else {
        await updateSupplierLoadRecord(load.id, { status: "SEARCHING", updatedAt: now() });
    }

    res.status(201).json({ success: true, load });
});

app.get("/api/supplier/loads", async (req, res) => {
    const user = await requireActor(req, res, ["supplier"]);
    if (user) res.json({ success: true, loads: await supplierLoadList(user.id) });
});

// Read the isolated MongoDB records: supplier_load.loads.
app.get("/api/supplier/load-records", async (req, res) => {
    const user = await requireActor(req, res, ["supplier"]);
    if (user) res.json({ success: true, records: await supplierLoadRecords(user.firebaseUid) });
});

app.post("/api/matching/closest-driver", async (req, res) => {
    const user = await requireActor(req, res, ["supplier"]);
    if (!user) return;
    const load = await loadForSupplier(req.body.loadId, user.id);
    if (!load) return res.status(404).json({ success: false, message: "Load not found." });
    const candidates = await eligibleDrivers(load);
    res.json({ success: true, driver: candidates[0] || null, candidates });
});

app.post("/api/assignment/offer", async (req, res) => {
    const user = await requireActor(req, res, ["supplier"]);
    if (!user) return;
    const load = await loadForSupplier(req.body.loadId, user.id);
    if (!load) return res.status(404).json({ success: false, message: "Load not found." });
    if (load.status === "ASSIGNED" || load.status === "OFFERED") return res.status(409).json({ success: false, message: "This load already has an active assignment." });
    const candidate = (await eligibleDrivers(load)).find((driver) => driver.id === req.body.driverId);
    if (!candidate) return res.status(409).json({ success: false, message: "That driver is no longer eligible. Refresh the match." });
    const assignment = await insert("assignments", { loadId: load.id, driverId: candidate.id, distanceKm: candidate.distanceKm, status: "OFFERED", createdAt: now() });
    await updateById("loads", load.id, { status: "OFFERED" });
    await updateSupplierLoadRecord(load.id, { status: "OFFERED", assignmentId: assignment.id, offeredDriverId: candidate.id, updatedAt: now() });
    res.status(201).json({ success: true, assignment });
});

app.post("/api/assignment/respond", async (req, res) => {
    const user = await requireActor(req, res, ["driver"]);
    if (!user) return;
    const response = String(req.body.response || "").toUpperCase();
    if (!["ACCEPT", "REJECT"].includes(response)) return res.status(400).json({ success: false, message: "Response must be ACCEPT or REJECT." });
    const driver = await findOne("drivers", { firebaseUid: user.firebaseUid });
    const assignment = await getById("assignments", req.body.assignmentId);
    if (!assignment || assignment.driverId !== driver.id || assignment.status !== "OFFERED") return res.status(404).json({ success: false, message: "Active offer not found." });
    const load = await getById("loads", assignment.loadId);
    if (!load) return res.status(404).json({ success: false, message: "Load not found." });

    if (response === "ACCEPT") {
        if (!["OFFERED", "SEARCHING"].includes(load.status)) return res.status(409).json({ success: false, message: "This load is no longer available." });
        await updateById("assignments", assignment.id, { status: "ACCEPTED", respondedAt: now() });
        await updateById("loads", load.id, { status: "ASSIGNED", assignedDriverId: driver.id });
        await updateSupplierLoadRecord(load.id, { status: "ASSIGNED", assignedDriverId: driver.id, assignmentId: assignment.id, updatedAt: now() });
        await updateById("drivers", driver.id, { available: false });
        return res.json({ success: true, status: "ASSIGNED", message: "Load assigned to you." });
    }

    await updateById("assignments", assignment.id, { status: "REJECTED", respondedAt: now() });
    const acceptedAssignment = db
        ? await db.collection("assignments").findOne({ loadId: load.id, status: "ACCEPTED" })
        : memory.assignments.find((a) => a.loadId === load.id && a.status === "ACCEPTED");

    if (!acceptedAssignment) {
        await updateById("loads", load.id, { status: "REJECTED" });
        await updateSupplierLoadRecord(load.id, { status: "REJECTED", lastRejectedAssignmentId: assignment.id, updatedAt: now() });
    }
    const nextDriver = (await eligibleDrivers(load)).find((candidate) => candidate.id !== driver.id) || null;
    res.json({ success: true, status: "REJECTED", nextDriver, message: "Offer declined. You can now find the next driver." });
});

// ── Delete a specific load and all its assignments (supports both DELETE and POST)
async function handleDeleteLoad(req, res) {
    const user = await requireActor(req, res, ["supplier"]);
    if (!user) return;
    const loadId = req.params.loadId || req.body?.loadId;
    const load = await getById("loads", loadId);
    if (!load || load.supplierId !== user.id) {
        return res.status(404).json({ success: false, message: "Load not found." });
    }
    await deleteMany("assignments", { loadId: load.id });
    await deleteById("loads", load.id);
    await removeSupplierLoad(load.id);
    res.json({ success: true, message: "Load removed successfully." });
}
app.delete("/api/supplier/load/:loadId", handleDeleteLoad);
app.post("/api/supplier/load/:loadId/delete", handleDeleteLoad);
app.post("/api/supplier/delete-load", handleDeleteLoad);

// ── Bulk delete all rejected loads for the logged-in supplier (supports both DELETE and POST)
async function handleClearRejectedLoads(req, res) {
    const user = await requireActor(req, res, ["supplier"]);
    if (!user) return;

    const allSupplierLoads = db
        ? await db.collection("loads").find({ supplierId: user.id }).toArray().then((items) => items.map(serialise))
        : clone(memory.loads.filter((l) => l.supplierId === user.id));

    let deletedCount = 0;
    for (const load of allSupplierLoads) {
        const hasAccepted = db
            ? await db.collection("assignments").findOne({ loadId: load.id, status: "ACCEPTED" })
            : memory.assignments.some((a) => a.loadId === load.id && a.status === "ACCEPTED");
        if (hasAccepted) continue;

        const isRejected = load.status === "REJECTED" || (db
            ? await db.collection("assignments").findOne({ loadId: load.id, status: "REJECTED" })
            : memory.assignments.some((a) => a.loadId === load.id && a.status === "REJECTED"));

        if (isRejected) {
            await deleteMany("assignments", { loadId: load.id });
            await deleteById("loads", load.id);
            await removeSupplierLoad(load.id);
            deletedCount++;
        }
    }
    res.json({ success: true, count: deletedCount, message: `Removed ${deletedCount} rejected load${deletedCount === 1 ? "" : "s"}.` });
}
app.delete("/api/supplier/rejected-loads", handleClearRejectedLoads);
app.post("/api/supplier/clear-rejected", handleClearRejectedLoads);

// ── Clear/dismiss a specific rejected assignment (resets load to SEARCHING)
app.delete("/api/supplier/assignment/:assignmentId", async (req, res) => {
    const user = await requireActor(req, res, ["supplier"]);
    if (!user) return;
    const assignment = await getById("assignments", req.params.assignmentId);
    if (!assignment) return res.status(404).json({ success: false, message: "Offer not found." });
    const load = await getById("loads", assignment.loadId);
    if (!load || load.supplierId !== user.id) return res.status(403).json({ success: false, message: "Unauthorized." });

    await deleteById("assignments", assignment.id);
    if (load.status === "REJECTED" || load.status === "OFFERED") {
        await updateById("loads", load.id, { status: "SEARCHING" });
        await updateSupplierLoadRecord(load.id, { status: "SEARCHING", updatedAt: now() });
    }
    res.json({ success: true, message: "Offer removed. Load reset to searching." });
});

app.use(express.static(path.resolve(__dirname, "../../Frontend")));
app.use((req, res, next) => {
    if (req.method === "GET" && !req.path.startsWith("/api")) {
        return res.sendFile(path.resolve(__dirname, "../../Frontend/index.html"));
    }
    next();
});
app.use((error, req, res, next) => {
    console.error(error);
    res.status(500).json({ success: false, message: error.message || "Something went wrong." });
});

connectStore()
    .then(() => app.listen(PORT, () => console.log(`Load n Go running at http://localhost:${PORT}`)))
    .catch((error) => {
        console.error("Could not start Load n Go:", error.message);
        process.exit(1);
    });

process.on("SIGINT", async () => {
    if (client) await client.close();
    process.exit(0);
});
