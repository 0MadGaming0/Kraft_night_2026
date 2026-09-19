# Freight Platform

A simple freight platform prototype focused on **Stage 1: user authentication and phone verification**.

The current implementation uses:

- Plain HTML, CSS, and JavaScript for the frontend
- Node.js built-in `http` module for the backend
- 2Factor for SMS OTP delivery and verification
- Environment variables for the 2Factor API key

## Current Scope

### Implemented

- User name input
- Phone number input
- 6-digit SMS OTP generation
- OTP verification
- Basic success state after verification
- In-memory OTP session handling on the backend

### Not Implemented Yet

The following features are intentionally outside the current stage:

- MongoDB profile storage
- Load matching
- Supplier/truck management
- Maps
- LLM features
- Delivery confirmation
- Advanced user roles
- Production deployment

## Project Structure

```text
Allan/
├── Backend/
│   ├── src/
│   │   └── server.js
│   ├── .env
│   ├── package.json
│   └── package-lock.json
│
├── Frontend/
│   ├── app.js
│   ├── index.html
│   └── style.css
│
└── .gitignore
```

## Prerequisites

Install:

- Node.js
- A 2Factor account with an API key
- A phone capable of receiving SMS

## Backend Setup

Open a terminal in the backend folder:

```powershell
cd Backend
npm install
```

Create a `.env` file inside `Backend/`:

```env
TWO_FACTOR_API_KEY=YOUR_2FACTOR_API_KEY
PORT=5000
```

Do not commit `.env` to Git.

Start the backend:

```powershell
npm run dev
```

The backend should run at:

```text
http://localhost:5000
```

You can also start it with:

```powershell
npm start
```

## Frontend Setup

Open `Frontend/index.html` using a local development server such as VS Code Live Server.

The frontend sends authentication requests to:

```text
http://localhost:5000
```

## Authentication Flow

```text
User enters name + phone
        ↓
Frontend
        ↓
POST /api/auth/send-otp
        ↓
Node.js backend
        ↓
2Factor SMS OTP
        ↓
User receives 6-digit OTP
        ↓
Frontend
        ↓
POST /api/auth/verify-otp
        ↓
Node.js backend
        ↓
2Factor OTP verification
        ↓
Phone verified
```

## API Endpoints

### Health Check

```http
GET /
```

Example response:

```json
{
  "success": true,
  "message": "Freight Platform backend is running"
}
```

### Send OTP

```http
POST /api/auth/send-otp
Content-Type: application/json
```

Request:

```json
{
  "phoneNumber": "+919876543210"
}
```

Example success response:

```json
{
  "success": true,
  "message": "OTP sent successfully"
}
```

### Verify OTP

```http
POST /api/auth/verify-otp
Content-Type: application/json
```

Request:

```json
{
  "phoneNumber": "+919876543210",
  "otp": "123456"
}
```

Example success response:

```json
{
  "success": true,
  "verified": true,
  "message": "Phone number verified successfully"
}
```

## Security Notes

- The 2Factor API key is stored in `Backend/.env`.
- The API key should never be placed in frontend JavaScript.
- `.env` and `node_modules` are excluded using `.gitignore`.
- OTP sessions are currently stored in backend memory, so restarting the server clears active OTP sessions.
- This authentication flow is intended for development/prototyping at the current stage.

## Git

The repository should track the application source files while excluding secrets and dependencies:

```gitignore
Backend/node_modules/
Backend/.env

Frontend/node_modules/
Frontend/.env
```

## Stage 1 Goal

The immediate goal is to establish a working authentication foundation:

```text
Name
  +
Phone Number
  ↓
SMS OTP
  ↓
OTP Verification
  ↓
Authenticated User
```

Future stages can build additional freight-platform functionality on top of this authentication layer.
