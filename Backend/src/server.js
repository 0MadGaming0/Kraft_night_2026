import "dotenv/config";
import http from "http";

const PORT = process.env.PORT || 5000;

const TWO_FACTOR_API_KEY =
    process.env.TWO_FACTOR_API_KEY;


// =====================================================
// Store active OTP sessions temporarily
// =====================================================
//
// phoneNumber -> 2Factor session ID
//
// This is okay for the current prototype.
// Later we can move this to Redis/MongoDB.
//

const otpSessions = new Map();


// =====================================================
// READ JSON BODY
// =====================================================

function readBody(req) {
    return new Promise((resolve, reject) => {

        let body = "";

        req.on("data", (chunk) => {
            body += chunk;
        });

        req.on("end", () => {

            try {
                resolve(
                    body ? JSON.parse(body) : {}
                );
            } catch (error) {
                reject(error);
            }

        });

        req.on("error", reject);
    });
}


// =====================================================
// SEND JSON RESPONSE
// =====================================================

function sendJSON(res, statusCode, data) {

    res.writeHead(statusCode, {
        "Content-Type": "application/json",

        "Access-Control-Allow-Origin": "*",

        "Access-Control-Allow-Methods":
            "GET,POST,OPTIONS",

        "Access-Control-Allow-Headers":
            "Content-Type"
    });

    res.end(
        JSON.stringify(data)
    );
}


// =====================================================
// VALIDATE PHONE
// =====================================================

function normalizePhone(phoneNumber) {

    if (
        !phoneNumber ||
        typeof phoneNumber !== "string"
    ) {
        return null;
    }

    let phone =
        phoneNumber
            .trim()
            .replace(/\s+/g, "");


    // Add + if user omitted it
    if (!phone.startsWith("+")) {
        phone = `+${phone}`;
    }


    // E.164-style validation
    if (!/^\+\d{10,15}$/.test(phone)) {
        return null;
    }

    return phone;
}


// =====================================================
// SERVER
// =====================================================

const server = http.createServer(
    async (req, res) => {

        console.log(
            `[${new Date().toISOString()}] ${req.method} ${req.url}`
        );


        // =============================================
        // CORS PREFLIGHT
        // =============================================

        if (req.method === "OPTIONS") {

            res.writeHead(204, {
                "Access-Control-Allow-Origin": "*",

                "Access-Control-Allow-Methods":
                    "GET,POST,OPTIONS",

                "Access-Control-Allow-Headers":
                    "Content-Type"
            });

            res.end();

            return;
        }


        // =============================================
        // HEALTH CHECK
        // =============================================

        if (
            req.method === "GET" &&
            req.url === "/"
        ) {

            sendJSON(
                res,
                200,
                {
                    success: true,
                    message:
                        "Freight Platform backend is running"
                }
            );

            return;
        }


        // =============================================
        // SEND SMS OTP
        // =============================================

        if (
            req.method === "POST" &&
            req.url === "/api/auth/send-otp"
        ) {

            try {

                const body =
                    await readBody(req);


                const phoneNumber =
                    normalizePhone(
                        body.phoneNumber
                    );


                // -------------------------------------
                // Validate phone
                // -------------------------------------

                if (!phoneNumber) {

                    sendJSON(
                        res,
                        400,
                        {
                            success: false,
                            message:
                                "Invalid phone number. Example: +919876543210"
                        }
                    );

                    return;
                }


                // -------------------------------------
                // Check API key
                // -------------------------------------

                if (!TWO_FACTOR_API_KEY) {

                    sendJSON(
                        res,
                        500,
                        {
                            success: false,
                            message:
                                "TWO_FACTOR_API_KEY is missing"
                        }
                    );

                    return;
                }


                // -------------------------------------
                // 2Factor expects number without "+"
                // -------------------------------------

                const phoneWithoutPlus =
                    phoneNumber.substring(1);


                // =====================================
                // SMS OTP ONLY
                // =====================================

                const otpURL =
                    `https://2factor.in/API/V1/${TWO_FACTOR_API_KEY}/SMS/${phoneWithoutPlus}/AUTOGEN`;


                console.log(
                    "Sending SMS OTP to:",
                    phoneNumber
                );


                const response =
                    await fetch(
                        otpURL,
                        {
                            method: "GET",
                            signal:
                                AbortSignal.timeout(15000)
                        }
                    );


                const rawResponse =
                    await response.text();


                console.log(
                    "2Factor status:",
                    response.status
                );

                console.log(
                    "2Factor response:",
                    rawResponse
                );


                // -------------------------------------
                // Parse response
                // -------------------------------------

                let result;

                try {

                    result =
                        JSON.parse(
                            rawResponse
                        );

                } catch {

                    result = {
                        rawResponse
                    };
                }


                // -------------------------------------
                // Check success
                // -------------------------------------

                if (
                    !response.ok ||
                    result.Status !== "Success"
                ) {

                    sendJSON(
                        res,
                        502,
                        {
                            success: false,
                            message:
                                "2Factor could not send SMS OTP",
                            providerResponse:
                                result
                        }
                    );

                    return;
                }


                // -------------------------------------
                // Store session ID server-side
                // -------------------------------------

                const sessionId =
                    result.Details;


                otpSessions.set(
                    phoneNumber,
                    {
                        sessionId,
                        createdAt: Date.now()
                    }
                );


                // -------------------------------------
                // IMPORTANT
                //
                // We do NOT return the session ID
                // to the browser.
                // -------------------------------------

                sendJSON(
                    res,
                    200,
                    {
                        success: true,
                        message:
                            "OTP sent successfully"
                    }
                );


            } catch (error) {

                console.error(
                    "SEND SMS OTP ERROR:",
                    error
                );


                sendJSON(
                    res,
                    500,
                    {
                        success: false,
                        message:
                            "Failed to send SMS OTP",
                        error:
                            error.message
                    }
                );
            }

            return;
        }


        // =============================================
        // VERIFY SMS OTP
        // =============================================

        if (
            req.method === "POST" &&
            req.url === "/api/auth/verify-otp"
        ) {

            try {

                const body =
                    await readBody(req);


                const phoneNumber =
                    normalizePhone(
                        body.phoneNumber
                    );


                const otp =
                    typeof body.otp === "string"
                        ? body.otp.trim()
                        : "";


                // -------------------------------------
                // Validate phone
                // -------------------------------------

                if (!phoneNumber) {

                    sendJSON(
                        res,
                        400,
                        {
                            success: false,
                            message:
                                "Invalid phone number"
                        }
                    );

                    return;
                }


                // -------------------------------------
                // Validate OTP
                // -------------------------------------

                if (!/^\d{6}$/.test(otp)) {

                    sendJSON(
                        res,
                        400,
                        {
                            success: false,
                            message:
                                "OTP must contain exactly 6 digits"
                        }
                    );

                    return;
                }


                // -------------------------------------
                // Get session
                // -------------------------------------

                const session =
                    otpSessions.get(
                        phoneNumber
                    );


                if (!session) {

                    sendJSON(
                        res,
                        400,
                        {
                            success: false,
                            message:
                                "OTP session not found. Request a new OTP."
                        }
                    );

                    return;
                }


                // -------------------------------------
                // Expire old sessions
                // -------------------------------------

                const SESSION_TIMEOUT =
                    5 * 60 * 1000;


                if (
                    Date.now() -
                    session.createdAt >
                    SESSION_TIMEOUT
                ) {

                    otpSessions.delete(
                        phoneNumber
                    );


                    sendJSON(
                        res,
                        400,
                        {
                            success: false,
                            message:
                                "OTP session expired. Request a new OTP."
                        }
                    );

                    return;
                }


                // =====================================
                // 2Factor VERIFY
                // =====================================

                const verifyURL =
                    `https://2factor.in/API/V1/${TWO_FACTOR_API_KEY}/SMS/VERIFY/${encodeURIComponent(session.sessionId)}/${encodeURIComponent(otp)}`;


                console.log(
                    "Verifying SMS OTP for:",
                    phoneNumber
                );


                const response =
                    await fetch(
                        verifyURL,
                        {
                            method: "GET",
                            signal:
                                AbortSignal.timeout(15000)
                        }
                    );


                const rawResponse =
                    await response.text();


                console.log(
                    "2Factor verify status:",
                    response.status
                );

                console.log(
                    "2Factor verify response:",
                    rawResponse
                );


                let result;

                try {

                    result =
                        JSON.parse(
                            rawResponse
                        );

                } catch {

                    result = {
                        rawResponse
                    };
                }


                // =====================================
                // OTP VERIFIED
                // =====================================

                if (
                    response.ok &&
                    result.Status === "Success"
                ) {

                    // Remove used session
                    otpSessions.delete(
                        phoneNumber
                    );


                    sendJSON(
                        res,
                        200,
                        {
                            success: true,
                            verified: true,
                            message:
                                "Phone number verified successfully"
                        }
                    );

                    return;
                }


                // =====================================
                // OTP FAILED
                // =====================================

                sendJSON(
                    res,
                    400,
                    {
                        success: false,
                        verified: false,
                        message:
                            "Invalid or expired OTP",
                        providerResponse:
                            result
                    }
                );


            } catch (error) {

                console.error(
                    "VERIFY OTP ERROR:",
                    error
                );


                sendJSON(
                    res,
                    500,
                    {
                        success: false,
                        verified: false,
                        message:
                            "Failed to verify OTP",
                        error:
                            error.message
                    }
                );
            }

            return;
        }


        // =============================================
        // 404
        // =============================================

        sendJSON(
            res,
            404,
            {
                success: false,
                message:
                    "Route not found"
            }
        );

    }
);


// =====================================================
// START SERVER
// =====================================================

server.listen(
    PORT,
    () => {

        console.log(
            `Backend running at http://localhost:${PORT}`
        );

        console.log(
            "SMS OTP provider: 2Factor"
        );

        console.log(
            "Voice OTP: DISABLED"
        );
    }
);