// ─────────────────────────────────────────────────────────────────────────────
// firebase-init.js
// Paste your Firebase Web App config below.
// Firebase Console → Project Settings → Your apps → SDK setup and configuration
// ─────────────────────────────────────────────────────────────────────────────
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
    getAuth,
    signInWithEmailAndPassword,
    createUserWithEmailAndPassword,
    signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

// ── FIREBASE CONFIG ──────────────────────────────────────────────────────────
const firebaseConfig = {
    apiKey:            "AIzaSyCE2u81rW1HTwMHJ1QomjHkPGqXcRrjEis",
    authDomain:        "running-b2025.firebaseapp.com",
    projectId:         "running-b2025",
    storageBucket:     "running-b2025.firebasestorage.app",
    messagingSenderId: "1027505630273",
    appId:             "1:1027505630273:web:d3bc6dca016741ad48eac0",
    measurementId:     "G-NEFQQ5CZHD"
};
// ─────────────────────────────────────────────────────────────────────────────

const FIREBASE_CONFIGURED = Boolean(firebaseConfig.apiKey && firebaseConfig.projectId);

let auth = null;

if (FIREBASE_CONFIGURED) {
    const firebaseApp = initializeApp(firebaseConfig);
    auth = getAuth(firebaseApp);
    console.log("Firebase: initialised for project", firebaseConfig.projectId);
} else {
    console.warn("Firebase: config is empty — supplier auth will fall back to demo password mode.");
}

/**
 * Sign an existing supplier in via Firebase Email/Password.
 * Returns the backend session payload { sessionId, user }.
 */
async function firebaseSignIn(email, password) {
    if (!auth) {
        // No Firebase config — use demo backend endpoint
        const res = await fetch("/api/auth/supplier/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, password })
        });
        const data = await res.json().catch(() => ({}));
        if (!data.success) throw new Error(data.message || "Sign-in failed.");
        return data;
    }

    // 1. Sign in with Firebase Auth
    const credential = await signInWithEmailAndPassword(auth, email, password);
    const idToken = await credential.user.getIdToken();

    // 2. Send the verified ID token to our backend → backend creates a server session
    const res = await fetch("/api/auth/supplier/firebase-verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken })
    });
    const data = await res.json().catch(() => ({}));
    if (!data.success) throw new Error(data.message || "Backend session creation failed.");
    return data;
}

/**
 * Register a new supplier via Firebase Email/Password, then persist the
 * company name to MongoDB through the backend.
 * Returns the backend session payload { sessionId, user }.
 */
async function firebaseRegister(email, password, companyName) {
    if (!auth) {
        // No Firebase config — use demo backend endpoint
        const res = await fetch("/api/auth/supplier/register", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ companyName, email, password })
        });
        const data = await res.json().catch(() => ({}));
        if (!data.success) throw new Error(data.message || "Registration failed.");
        return data;
    }

    // 1. Create account in Firebase Auth
    const credential = await createUserWithEmailAndPassword(auth, email, password);
    const idToken = await credential.user.getIdToken();

    // 2. Send token + company name to backend → stores in MongoDB
    const res = await fetch("/api/auth/supplier/firebase-register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken, companyName })
    });
    const data = await res.json().catch(() => ({}));
    if (!data.success) {
        // Clean up the Firebase Auth account if backend failed
        await credential.user.delete().catch(() => {});
        throw new Error(data.message || "Account created in Firebase but failed to save to database.");
    }
    return data;
}

/**
 * Sign out of Firebase (called on logout).
 */
async function firebaseSignOut() {
    if (auth) await signOut(auth).catch(() => {});
}

// Expose to app.js (loaded as a regular script, not a module)
window.__firebase = { firebaseSignIn, firebaseRegister, firebaseSignOut, isConfigured: FIREBASE_CONFIGURED };
