// =====================================================
// FRONTEND CONFIGURATION
// =====================================================

const API_BASE_URL = "http://localhost:5000";


// =====================================================
// GET HTML ELEMENTS
// =====================================================

const nameInput =
    document.getElementById("name");

const phoneInput =
    document.getElementById("phone");

const otpInput =
    document.getElementById("otp");

const sendOTPButton =
    document.getElementById("send-otp-button");

const verifyOTPButton =
    document.getElementById("verify-otp-button");

const userInformation =
    document.getElementById("user-information");

const otpVerification =
    document.getElementById("otp-verification");

const authenticationSuccess =
    document.getElementById("authentication-success");

const otpMessage =
    document.getElementById("otp-message");

const statusMessage =
    document.getElementById("status-message");

const welcomeMessage =
    document.getElementById("welcome-message");


// =====================================================
// CHECK HTML
// =====================================================

if (
    !nameInput ||
    !phoneInput ||
    !otpInput ||
    !sendOTPButton ||
    !verifyOTPButton ||
    !userInformation ||
    !otpVerification ||
    !authenticationSuccess ||
    !otpMessage ||
    !statusMessage ||
    !welcomeMessage
) {
    console.error(
        "Required HTML elements are missing."
    );
}


// =====================================================
// SEND OTP
// =====================================================

sendOTPButton.addEventListener(
    "click",
    async () => {

        const name =
            nameInput.value.trim();

        const phone =
            phoneInput.value.trim();


        // ---------------------------------------------
        // Validate name
        // ---------------------------------------------

        if (!name) {

            statusMessage.textContent =
                "Please enter your name.";

            nameInput.focus();

            return;
        }


        // ---------------------------------------------
        // Validate phone
        // ---------------------------------------------
        //
        // Example:
        // +919876543210
        //
        // ---------------------------------------------

        if (!/^\+\d{10,15}$/.test(phone)) {

            statusMessage.textContent =
                "Enter phone number like +919876543210.";

            phoneInput.focus();

            return;
        }


        // ---------------------------------------------
        // Disable button
        // ---------------------------------------------

        sendOTPButton.disabled = true;

        sendOTPButton.textContent =
            "Sending OTP...";

        statusMessage.textContent =
            "Sending SMS OTP...";


        try {

            // =========================================
            // CALL BACKEND
            // =========================================

            const response =
                await fetch(
                    `${API_BASE_URL}/api/auth/send-otp`,
                    {
                        method: "POST",

                        headers: {
                            "Content-Type":
                                "application/json"
                        },

                        body: JSON.stringify({
                            phoneNumber: phone
                        })
                    }
                );


            // -----------------------------------------
            // Read backend response
            // -----------------------------------------

            const data =
                await response.json();


            console.log(
                "Send OTP response:",
                data
            );


            // -----------------------------------------
            // Check response
            // -----------------------------------------

            if (
                !response.ok ||
                !data.success
            ) {

                throw new Error(
                    data.message ||
                    "Failed to send OTP."
                );
            }


            // =========================================
            // OTP SENT
            // =========================================

            userInformation.hidden = true;

            otpVerification.hidden = false;


            otpMessage.textContent =
                `Enter the 6-digit OTP sent to ${phone}`;


            statusMessage.textContent =
                "OTP sent successfully.";

            otpInput.focus();


        } catch (error) {

            console.error(
                "Send OTP error:",
                error
            );


            statusMessage.textContent =
                error.message ||
                "Could not send OTP.";


            // Re-enable button

            sendOTPButton.disabled = false;

            sendOTPButton.textContent =
                "Send OTP";
        }

    }
);


// =====================================================
// VERIFY OTP
// =====================================================

verifyOTPButton.addEventListener(
    "click",
    async () => {

        const name =
            nameInput.value.trim();

        const phone =
            phoneInput.value.trim();

        const otp =
            otpInput.value.trim();


        // ---------------------------------------------
        // Validate OTP
        // ---------------------------------------------

        if (!/^\d{6}$/.test(otp)) {

            statusMessage.textContent =
                "Enter the 6-digit OTP.";

            otpInput.focus();

            return;
        }


        verifyOTPButton.disabled = true;

        verifyOTPButton.textContent =
            "Verifying...";

        statusMessage.textContent =
            "Verifying your phone number...";


        try {

            // =========================================
            // CALL BACKEND
            // =========================================

            const response =
                await fetch(
                    `${API_BASE_URL}/api/auth/verify-otp`,
                    {
                        method: "POST",

                        headers: {
                            "Content-Type":
                                "application/json"
                        },

                        body: JSON.stringify({
                            phoneNumber: phone,
                            otp: otp
                        })
                    }
                );


            // -----------------------------------------
            // Read backend response
            // -----------------------------------------

            const data =
                await response.json();


            console.log(
                "Verify OTP response:",
                data
            );


            // -----------------------------------------
            // Check verification
            // -----------------------------------------

            if (
                !response.ok ||
                !data.success ||
                !data.verified
            ) {

                throw new Error(
                    data.message ||
                    "OTP verification failed."
                );
            }


            // =========================================
            // SUCCESS
            // =========================================

            otpVerification.hidden = true;

            authenticationSuccess.hidden =
                false;


            welcomeMessage.textContent =
                `Welcome ${name}!`;


            statusMessage.textContent =
                "Phone number verified successfully.";


            console.log(
                "================================"
            );

            console.log(
                "STAGE 1 AUTHENTICATION COMPLETE"
            );

            console.log(
                "Name:",
                name
            );

            console.log(
                "Phone:",
                phone
            );

            console.log(
                "================================"
            );


        } catch (error) {

            console.error(
                "Verify OTP error:",
                error
            );


            statusMessage.textContent =
                error.message ||
                "OTP verification failed.";


            verifyOTPButton.disabled =
                false;

            verifyOTPButton.textContent =
                "Verify OTP";
        }

    }
);