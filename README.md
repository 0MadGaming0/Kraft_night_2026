# CoLoad MVP

CoLoad proves one logistics workflow end to end: a driver shares a live GPS location, a supplier creates a load, the system selects the closest available driver with sufficient capacity, and the driver accepts or rejects the offer.

## Run it

1. In `Backend`, copy `.env.example` to `.env` and add `MONGODB_URI` when MongoDB is available.
2. Run `npm start` from `Backend`.
3. Open `http://localhost:5000`.

Without MongoDB, the app uses a self-contained in-memory demo store so the full workflow remains demonstrable. MongoDB mode creates the `drivers.currentLocation` `2dsphere` index and uses `$geoNear` for matching.

## Demo flow

1. Sign in as a driver using any valid-format phone number. In demo mode, the OTP is `123456`.
2. On the driver dashboard, share location (or use the automatic Kollam demo-location fallback).
3. Sign out and sign in as the supplier: `supplier@coload.demo` / `123456`.
4. Use the pickup-location button, create a load, and send the recommended driver an offer.
5. Return to the driver account and accept it. Both roles will show the assigned state.

For a live demo, use a second browser profile for the driver and supplier dashboards. The backend session is intentionally lightweight for the hackathon MVP. Use Firebase-issued tokens and password hashing before any production deployment.
