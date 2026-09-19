const API = "http://127.0.0.1:5000/api";
const DEMO_LOCATION = { latitude: 8.8932, longitude: 76.6141, accuracy: 12 };
const state = {
  sessionId: sessionStorage.getItem("loadngo-session"),
  user: null,
  pickup: null,
  locationWatch: null,
  refreshTimer: null,
  currentMatch: null,
  currentLoad: null,
  lastLocationSentAt: 0,
  lastKnownStatuses: {},
};
const $ = (selector) => document.querySelector(selector);

function setNotice(target, message = "", type = "") {
  const element = $(target);
  element.textContent = message;
  element.className = `notice ${type}`;
}
function toast(message, type = "") {
  const element = $("#toast");
  element.textContent = message;
  element.className = `toast visible ${type}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (element.className = "toast"), 3500);
}
async function request(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(state.sessionId ? { "X-Session-Id": state.sessionId } : {}),
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.success)
    throw new Error(data.message || "Something went wrong.");
  return data;
}
function showPage(page) {
  ["#authScreen", "#driverScreen", "#supplierScreen"].forEach(
    (selector) => ($(selector).hidden = selector !== `#${page}`),
  );
  window.scrollTo({ top: 0, behavior: "smooth" });
}
function formatDate(value) {
  return new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
function formatCurrency(currency, amount) {
  if (!currency || !Number.isFinite(Number(amount))) return "";
  try {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(Number(amount));
  } catch {
    return `${currency} ${Number(amount).toFixed(2)}`;
  }
}
function defaultDateTime() {
  const local = new Date(
    Date.now() + 2 * 60 * 60 * 1000 - new Date().getTimezoneOffset() * 60_000,
  );
  return local.toISOString().slice(0, 16);
}
function safe(value) {
  const node = document.createElement("span");
  node.textContent = value ?? "";
  return node.innerHTML;
}

function selectRole(role) {
  document
    .querySelectorAll(".role-tab")
    .forEach((button) =>
      button.classList.toggle("active", button.dataset.role === role),
    );
  $("#driverAuth").hidden = role !== "driver";
  $("#supplierAuth").hidden = role !== "supplier";
  setNotice("#authNotice");
}
async function signIn(data) {
  state.sessionId = data.sessionId;
  state.user = data.user;
  sessionStorage.setItem("loadngo-session", state.sessionId);
  if (state.user.role === "driver") {
    $("#driverGreeting").textContent = state.user.name.split(" ")[0];
    showPage("driverScreen");
    await refreshDriver();
    await sendLocation(DEMO_LOCATION, "demo");
  } else {
    $("#supplierGreeting").textContent =
      `Welcome, ${state.user.name}. The pickup GPS location powers the nearby-driver match.`;
    showPage("supplierScreen");
    await refreshSupplier();
  }
  startRefresh();
}
async function sendOtp() {
  const phoneNumber = $("#driverPhoneInput").value.trim();
  if (!$("#driverNameInput").value.trim())
    return setNotice("#authNotice", "Enter your full name first.", "error");
  try {
    const data = await request("/auth/driver/send-otp", {
      method: "POST",
      body: JSON.stringify({ phoneNumber }),
    });
    $("#otpPanel").hidden = false;
    $("#otpInput").focus();
    setNotice(
      "#authNotice",
      data.demoCode
        ? `Demo mode: use OTP ${data.demoCode}.`
        : "OTP sent. Check your phone.",
      "success",
    );
  } catch (error) {
    setNotice("#authNotice", error.message, "error");
  }
}
async function verifyOtp() {
  try {
    const data = await request("/auth/driver/verify-otp", {
      method: "POST",
      body: JSON.stringify({
        name: $("#driverNameInput").value.trim(),
        phoneNumber: $("#driverPhoneInput").value.trim(),
        otp: $("#otpInput").value.trim(),
      }),
    });
    await signIn(data);
  } catch (error) {
    setNotice("#authNotice", error.message, "error");
  }
}
async function supplierLogin() {
  try {
    const email = $("#supplierEmailInput").value.trim();
    const password = $("#supplierPasswordInput").value;
    if (!email || !password)
      return setNotice(
        "#authNotice",
        "Enter your email and password.",
        "error",
      );
    setNotice("#authNotice", "Signing in…");
    const fb = window.__firebase;
    const data = await (fb
      ? fb.firebaseSignIn(email, password)
      : Promise.reject(new Error("Firebase not loaded yet.")));
    await signIn(data);
  } catch (error) {
    setNotice("#authNotice", error.message, "error");
  }
}
async function registerSupplier() {
  try {
    const companyName = $("#companyNameInput").value.trim();
    const email = $("#supplierEmailInput").value.trim();
    const password = $("#supplierPasswordInput").value;
    if (!companyName)
      return setNotice("#authNotice", "Enter a company name.", "error");
    if (!email)
      return setNotice("#authNotice", "Enter your work email.", "error");
    if (password.length < 6)
      return setNotice(
        "#authNotice",
        "Password must be at least 6 characters.",
        "error",
      );
    setNotice("#authNotice", "Creating your account…");
    const fb = window.__firebase;
    const data = await (fb
      ? fb.firebaseRegister(email, password, companyName)
      : Promise.reject(new Error("Firebase not loaded yet.")));
    await signIn(data);
  } catch (error) {
    setNotice("#authNotice", error.message, "error");
  }
}
async function sendLocation(location, source = "live") {
  try {
    await request("/driver/location", {
      method: "POST",
      body: JSON.stringify(location),
    });
    state.lastLocationSentAt = Date.now();
    $("#locationDot").className = "dot active";
    $("#locationLabel").textContent = "Live location active";
    $("#locationDetail").textContent =
      `${source === "live" ? "GPS" : "Demo"} location · accuracy ${Math.round(location.accuracy || 0)} m · just updated`;
  } catch (error) {
    toast(error.message, "error");
  }
}
function shareLocation() {
  if (!navigator.geolocation) {
    sendLocation(DEMO_LOCATION, "demo");
    return;
  }
  $("#shareLocationButton").disabled = true;
  $("#shareLocationButton").textContent = "Requesting location…";
  navigator.geolocation.getCurrentPosition(
    (position) => {
      const { latitude, longitude, accuracy } = position.coords;
      sendLocation({ latitude, longitude, accuracy });
      if (state.locationWatch === null)
        state.locationWatch = navigator.geolocation.watchPosition(
          (next) => {
            if (Date.now() - state.lastLocationSentAt >= 5000)
              sendLocation(next.coords);
          },
          () => {},
          { enableHighAccuracy: true, maximumAge: 5000, timeout: 12000 },
        );
      $("#shareLocationButton").disabled = false;
      $("#shareLocationButton").textContent = "Location sharing active";
    },
    () => {
      sendLocation(DEMO_LOCATION, "demo");
      $("#shareLocationButton").disabled = false;
      $("#shareLocationButton").textContent = "Using demo pickup location";
      toast("GPS unavailable — using the Kollam demo location.");
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 5000 },
  );
}
async function refreshDriver() {
  try {
    const data = await request("/driver/jobs");
    const driver = data.driver;
    $("#availabilityToggle").checked = driver.available;
    updateAvailability(driver.available);
    if (driver.lastLocationUpdate) {
      $("#locationDot").className = "dot active";
      $("#locationLabel").textContent = "Live location active";
      $("#locationDetail").textContent =
        `Accuracy ${driver.locationAccuracy ?? "—"} m · last updated ${formatDate(driver.lastLocationUpdate)}`;
    }
    renderDriverJobs(data.jobs);
  } catch (error) {
    toast(error.message, "error");
  }
}
function updateAvailability(available) {
  $("#availabilityLabel").textContent = available ? "Available" : "Offline";
  $("#availabilityCopy").textContent = available
    ? "You can receive nearby load offers."
    : "You will not be included in matches.";
}
function renderDriverJobs(jobs) {
  const destination = $("#driverJobs");
  if (!jobs.length) {
    destination.innerHTML =
      '<div class="empty-state">No active jobs. Keep your live location and availability on.</div>';
    return;
  }
  destination.innerHTML = jobs
    .map(({ id, status, load, distanceKm }) => {
      const isAccepted = status === "ACCEPTED";
      const pickupCoords = load?.pickup?.location?.coordinates;
      const mapsUrl = pickupCoords ? `https://www.google.com/maps/dir/?api=1&destination=${pickupCoords[1]},${pickupCoords[0]}` : null;

      return `
        <article class="job-card ${status.toLowerCase()}">
          <div class="job-body">
            <div class="job-badge-row">
              <span class="status-pill ${isAccepted ? "success" : "warning"}">● ${isAccepted ? "ACCEPTED & ACTIVE" : "NEW LOAD OFFER"}</span>
              <span class="company-tag">${safe(load.companyName || "Supplier")}</span>
            </div>
            <h2>${safe(load.goodsType)}</h2>
            <p class="route">Pickup → ${safe(load.destination)}</p>

            ${isAccepted ? `
              <div class="load-accepted-details-grid">
                <div class="detail-item highlight">
                  <small>PAYOUT</small>
                  <strong>${formatCurrency(load.currency, load.currencyAmount) || "—"}</strong>
                </div>
                <div class="detail-item">
                  <small>QUANTITY</small>
                  <span>${load.quantityKg ? load.quantityKg.toLocaleString("en-IN") + " kg" : "—"}</span>
                </div>
                <div class="detail-item">
                  <small>REQUIRED AT</small>
                  <span>${formatDate(load.requiredAt)}</span>
                </div>
                <div class="detail-item">
                  <small>DISTANCE TO PICKUP</small>
                  <span>${distanceKm} km</span>
                </div>
                ${load.supplierEmail || load.supplierPhone ? `
                  <div class="detail-item wide">
                    <small>SUPPLIER CONTACT</small>
                    <span>${safe(load.supplierEmail || "")}${load.supplierPhone ? ` · 📞 ${safe(load.supplierPhone)}` : ""}</span>
                  </div>
                ` : ""}
                ${load.supplierCompany ? `
                  <div class="detail-item wide" style="background: rgba(32,200,90,0.04); border: 1px solid rgba(32,200,90,0.15); padding: 12px; border-radius: 8px; margin-top: 8px;">
                    <small style="color: var(--green-light); font-weight: 800; display: block; margin-bottom: 6px;">VERIFIED SUPPLIER & LEGAL INFO</small>
                    <p style="margin-bottom: 4px;"><strong>Company:</strong> ${safe(load.supplierCompany)} <span class="status-badge" style="padding: 2px 6px; font-size: 9px; margin-left: 6px;">✓ ${safe(load.supplierStatus)}</span></p>
                    <p style="margin-bottom: 4px;"><strong>Reg Number:</strong> ${safe(load.supplierRegistration)}</p>
                    <p style="font-size: 11px; color: var(--text-muted); line-height: 1.4;">${safe(load.legalDisclaimer)}</p>
                  </div>
                ` : ""}
              </div>
            ` : `
              <div class="job-metrics">
                <span>${load.quantityKg ? load.quantityKg.toLocaleString("en-IN") + " kg" : ""}</span>
                <span>${distanceKm} km to pickup</span>
                <span>${formatDate(load.requiredAt)}</span>
                ${load.currencyAmount ? `<span>${formatCurrency(load.currency, load.currencyAmount)}</span>` : ""}
              </div>
              ${load.supplierCompany ? `
              <div class="legal-notice" style="margin-top: 14px; padding: 12px; background: rgba(32,200,90,0.04); border: 1px solid rgba(32,200,90,0.15); border-radius: 8px;">
                <small style="color: var(--green-light); font-weight: 800; font-size: 10px; display: block; margin-bottom: 4px;">VERIFIED SUPPLIER: ${safe(load.supplierCompany)} (Reg: ${safe(load.supplierRegistration)})</small>
                <p class="small-copy" style="color: var(--text-muted); line-height: 1.4;">${safe(load.legalDisclaimer)}</p>
              </div>
              ` : ""}
            `}
          </div>

          ${isAccepted ? `
            <div class="accepted-job-actions">
              <span class="status-badge assigned">JOB IN PROGRESS</span>
              ${mapsUrl ? `<a href="${mapsUrl}" target="_blank" rel="noopener noreferrer" class="button secondary small-btn">📍 Open Navigation</a>` : ""}
            </div>
          ` : `
            <div class="offer-actions">
              <button class="button primary" data-response="ACCEPT" data-assignment="${id}">Accept load</button>
              <button class="button secondary" data-response="REJECT" data-assignment="${id}">Reject</button>
            </div>
          `}
        </article>
      `;
    })
    .join("");

  destination
    .querySelectorAll("[data-response]")
    .forEach((button) =>
      button.addEventListener("click", () =>
        respondToOffer(button.dataset.assignment, button.dataset.response),
      ),
    );
}
async function respondToOffer(assignmentId, response) {
  try {
    const data = await request("/assignment/respond", {
      method: "POST",
      body: JSON.stringify({ assignmentId, response }),
    });
    toast(data.message, "success");
    await refreshDriver();
  } catch (error) {
    toast(error.message, "error");
  }
}
function setPickup(location, source = "live") {
  state.pickup = {
    location: {
      type: "Point",
      coordinates: [location.longitude, location.latitude],
    },
  };
  $("#pickupDot").className = "dot active";
  $("#pickupLabel").textContent =
    `${source === "live" ? "Current" : "Demo"} pickup location ready`;
}
function choosePickupLocation() {
  if (!navigator.geolocation) return setPickup(DEMO_LOCATION, "demo");
  $("#pickupLabel").textContent = "Getting current location…";
  navigator.geolocation.getCurrentPosition(
    (position) => setPickup(position.coords),
    () => {
      setPickup(DEMO_LOCATION, "demo");
      toast("GPS unavailable — using the Kollam demo pickup.");
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 5000 },
  );
}
async function createLoad(event) {
  event.preventDefault();
  if (!state.pickup)
    return setNotice(
      "#loadNotice",
      "Select the pickup location before creating this load.",
      "error",
    );
  try {
    setNotice("#loadNotice", "Finding eligible drivers…");
    const loadData = await request("/supplier/load", {
      method: "POST",
      body: JSON.stringify({
        goodsType: $("#goodsType").value.trim(),
        quantityKg: $("#quantityKg").value,
        currency: $("#currency").value,
        currencyAmount: $("#currencyAmount").value,
        pickup: state.pickup,
        destination: $("#destination").value.trim(),
        requiredAt: new Date($("#requiredAt").value).toISOString(),
      }),
    });
    state.currentLoad = loadData.load;
    
    if (loadData.load.status === "OFFERED" || loadData.load.status === "ASSIGNED") {
      state.currentLoad = null; // Hide match card since it's already sent
      state.currentMatch = null;
      renderMatch(null, 0);
      setNotice("#loadNotice", "Load automatically matched and offered to the nearest driver!", "success");
    } else {
      const matchData = await request("/matching/closest-driver", {
        method: "POST",
        body: JSON.stringify({ loadId: state.currentLoad.id }),
      });
      state.currentMatch = matchData.driver;
      renderMatch(matchData.driver, matchData.candidates.length);
      setNotice("#loadNotice", "Load created. Waiting for drivers.", "success");
    }

    await refreshSupplier();
  } catch (error) {
    setNotice("#loadNotice", error.message, "error");
  }
}
function renderMatch(driver, candidateCount) {
  $("#matchEmpty").hidden = Boolean(driver);
  const result = $("#matchResult");
  result.hidden = !driver;
  if (!driver) {
    $("#matchEmpty").hidden = false;
    $("#matchEmpty").innerHTML =
      '<div class="match-icon">⌖</div><h2>No fresh match yet.</h2><p class="muted">Ask a nearby driver to come online and share their location, then create another load.</p>';
    return;
  }
  result.innerHTML = `<div class="driver-avatar">${safe(driver.name)
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(
      0,
      2,
    )}</div><h2>${safe(driver.name)}</h2><p class="verified">● VERIFIED &amp; AVAILABLE</p><div class="match-stats"><div><span>${safe(driver.vehicle.type)}</span><small>VEHICLE</small></div><div><span>${driver.vehicle.capacityKg.toLocaleString("en-IN")} kg</span><small>CAPACITY</small></div><div><strong>${driver.distanceKm} km</strong><small>AWAY</small></div></div><p class="muted small-copy">Closest of ${candidateCount} eligible nearby driver${candidateCount === 1 ? "" : "s"}.</p><button id="sendOfferButton" class="button primary" type="button">Send offer <span>→</span></button>`;
  $("#sendOfferButton").addEventListener("click", sendOffer);
}
async function sendOffer() {
  try {
    await request("/assignment/offer", {
      method: "POST",
      body: JSON.stringify({
        loadId: state.currentLoad.id,
        driverId: state.currentMatch.id,
      }),
    });
    toast(`Offer sent to ${state.currentMatch.name}.`, "success");
    $("#sendOfferButton").disabled = true;
    $("#sendOfferButton").textContent = "Offer sent";
    await refreshSupplier();
  } catch (error) {
    toast(error.message, "error");
  }
}
async function refreshSupplier() {
  try {
    const data = await request("/supplier/loads");
    const loads = data.loads || [];

    // Live feedback toasts on state changes
    loads.forEach((load) => {
      const prevStatus = state.lastKnownStatuses[load.id];
      const currStatus = load.status;
      if (prevStatus && prevStatus !== currStatus) {
        if (currStatus === "ASSIGNED" || load.assignment?.status === "ACCEPTED") {
          toast(`🎉 Driver ${load.driverInfo?.name || "assigned"} accepted your load for "${load.goodsType}"!`, "success");
        } else if (currStatus === "REJECTED" || load.isRejected) {
          toast(`⚠️ Driver declined offer for "${load.goodsType}".`, "error");
        }
      }
      state.lastKnownStatuses[load.id] = currStatus;
    });

    // Match card in 1st image disappears once the driver accepts or rejects the load (or it gets auto-offered)
    if (state.currentLoad) {
      const activeLoad = loads.find((l) => l.id === state.currentLoad.id);
      if (!activeLoad || activeLoad.status === "ASSIGNED" || activeLoad.status === "REJECTED" || activeLoad.isRejected || activeLoad.status === "OFFERED" || activeLoad.assignment?.status === "ACCEPTED" || activeLoad.assignment?.status === "REJECTED") {
        state.currentLoad = null;
        state.currentMatch = null;
        renderMatch(null, 0);
      }
    }

    // Update clear rejected button visibility
    const rejectedCount = loads.filter((l) => l.status === "REJECTED" || l.isRejected).length;
    const clearBtn = $("#clearRejectedButton");
    if (clearBtn) {
      clearBtn.hidden = rejectedCount === 0;
      clearBtn.textContent = `🗑️ Clear rejected (${rejectedCount})`;
    }

    renderSupplierLoads(loads);
  } catch (error) {
    toast(error.message, "error");
  }
}

function renderSupplierLoads(loads) {
  const list = $("#supplierLoads");
  if (!loads.length) {
    list.innerHTML = '<div class="empty-state">No loads yet.</div>';
    return;
  }

  list.innerHTML = loads
    .map((load) => {
      const isAssigned = load.status === "ASSIGNED" || load.assignment?.status === "ACCEPTED";
      const isRejected = load.status === "REJECTED" || load.isRejected;
      const isOffered = !isAssigned && !isRejected && load.status === "OFFERED";
      const isSearching = !isAssigned && !isRejected && !isOffered;

      let statusPillClass = "searching";
      let statusPillText = "● SEARCHING";
      let statusIndicatorText = "Finding driver";

      if (isAssigned) {
        statusPillClass = "success";
        statusPillText = "● DRIVER ASSIGNED & ACCEPTED";
        statusIndicatorText = "Driver en route";
      } else if (isRejected) {
        statusPillClass = "danger";
        statusPillText = "● OFFER DECLINED";
        statusIndicatorText = "Offer declined";
      } else if (isOffered) {
        statusPillClass = "warning pulse";
        statusPillText = "● OFFER SENT";
        statusIndicatorText = "Awaiting response";
      }

      return `
        <article class="load-row ${isAssigned ? "assigned" : ""} ${isRejected ? "rejected" : ""} ${isOffered ? "offered" : ""}">
          <div class="load-main">
            <div class="load-badge-row">
              <span class="status-pill ${statusPillClass}">${statusPillText}</span>
              <span class="company-tag">${safe(load.companyName || "SUPPLIER LOAD")}</span>
            </div>
            <h3>${safe(load.goodsType)} <span>· ${load.quantityKg.toLocaleString("en-IN")} kg</span></h3>
            <p class="muted">Pickup → ${safe(load.destination)} · ${formatDate(load.requiredAt)}</p>

            ${isAssigned && load.driverInfo ? `
              <div class="driver-accepted-card">
                <div class="driver-avatar-badge">${safe(load.driverInfo.name).split(" ").map((p) => p[0]).join("").slice(0, 2)}</div>
                <div class="driver-accepted-text">
                  <div class="driver-name-line">
                    <strong>${safe(load.driverInfo.name)}</strong>
                    <span class="badge-tag">Verified Driver</span>
                  </div>
                  <div class="driver-accepted-meta">
                    ${load.driverInfo.phone ? `<a href="tel:${safe(load.driverInfo.phone)}" class="driver-contact-link">📞 ${safe(load.driverInfo.phone)}</a>` : ""}
                    <span>🚛 ${safe(load.driverInfo.vehicle?.type || "Truck")} (${(load.driverInfo.vehicle?.capacityKg || 0).toLocaleString("en-IN")} kg)</span>
                    <span>📍 ${load.driverInfo.distanceKm} km from pickup</span>
                  </div>
                </div>
              </div>
            ` : ""}

            ${isRejected ? `
              <p class="rejection-note">${load.driverInfo ? `Driver <strong>${safe(load.driverInfo.name)}</strong> declined this offer.` : "Driver declined this offer."} You can remove this offer or find another driver.</p>
            ` : ""}

            ${isOffered ? `
              <p class="waiting-note">${load.driverInfo ? `Waiting for response from <strong>${safe(load.driverInfo.name)}</strong> (${load.driverInfo.distanceKm} km away)…` : "Waiting for nearby driver to accept…"}</p>
            ` : ""}
          </div>

          <div class="load-assignment">
            <strong>${formatCurrency(load.currency, load.currencyAmount)}</strong>
            <span class="status-indicator ${statusPillClass.replace(" pulse", "")}">${statusIndicatorText}</span>
            <div class="row-actions">
              ${isRejected ? `
                <button class="btn-action rematch" data-action="rematch" data-load-id="${load.id}" title="Find another driver">🔄 Re-match</button>
                <button class="btn-action delete" data-action="delete-load" data-load-id="${load.id}" title="Remove rejected offer">🗑️ Remove</button>
              ` : isSearching ? `
                <button class="btn-action rematch" data-action="rematch" data-load-id="${load.id}" title="Find matching driver">⌖ Match</button>
                <button class="btn-action delete" data-action="delete-load" data-load-id="${load.id}" title="Delete load">🗑️ Delete</button>
              ` : isOffered ? `
                <button class="btn-action delete" data-action="delete-load" data-load-id="${load.id}" title="Cancel offer and delete load">🗑️ Cancel</button>
              ` : `
                <button class="btn-action delete" data-action="delete-load" data-load-id="${load.id}" title="Delete completed or assigned load">🗑️ Delete</button>
              `}
            </div>
          </div>
        </article>
      `;
    })
    .join("");

  list.querySelectorAll('[data-action="delete-load"]').forEach((btn) => {
    btn.addEventListener("click", () => deleteLoad(btn.dataset.loadId));
  });

  list.querySelectorAll('[data-action="rematch"]').forEach((btn) => {
    btn.addEventListener("click", () => rematchLoad(btn.dataset.loadId));
  });
}

async function deleteLoad(loadId) {
  try {
    let data;
    try {
      data = await request(`/supplier/load/${loadId}/delete`, {
        method: "POST",
        body: JSON.stringify({ loadId }),
      });
    } catch {
      data = await request(`/supplier/load/${loadId}`, { method: "DELETE" });
    }
    toast(data.message || "Load removed successfully.", "success");
    delete state.lastKnownStatuses[loadId];
    if (state.currentLoad?.id === loadId) {
      state.currentLoad = null;
      state.currentMatch = null;
      renderMatch(null, 0);
    }
    await refreshSupplier();
  } catch (error) {
    toast(error.message, "error");
  }
}

async function clearRejectedLoads() {
  try {
    let data;
    try {
      data = await request("/supplier/clear-rejected", { method: "POST" });
    } catch {
      data = await request("/supplier/rejected-loads", { method: "DELETE" });
    }
    toast(data.message || "Rejected loads cleared.", "success");
    await refreshSupplier();
  } catch (error) {
    toast(error.message, "error");
  }
}

async function rematchLoad(loadId) {
  try {
    state.currentLoad = { id: loadId };
    const matchData = await request("/matching/closest-driver", {
      method: "POST",
      body: JSON.stringify({ loadId }),
    });
    state.currentMatch = matchData.driver;
    renderMatch(matchData.driver, matchData.candidates.length);
    toast("Searched for eligible drivers.", "success");
    window.scrollTo({ top: 0, behavior: "smooth" });
  } catch (error) {
    toast(error.message, "error");
  }
}

function startRefresh() {
  clearInterval(state.refreshTimer);
  state.refreshTimer = setInterval(
    () => (state.user?.role === "driver" ? refreshDriver() : refreshSupplier()),
    2500,
  );
}

function logout() {
  if (state.locationWatch !== null)
    navigator.geolocation?.clearWatch(state.locationWatch);
  clearInterval(state.refreshTimer);
  sessionStorage.removeItem("loadngo-session");
  Object.assign(state, {
    sessionId: null,
    user: null,
    pickup: null,
    currentMatch: null,
    currentLoad: null,
    locationWatch: null,
    lastKnownStatuses: {},
  });
  if (window.__firebase) window.__firebase.firebaseSignOut();
  showPage("authScreen");
}

async function restoreSession() {
  if (!state.sessionId) return;
  try {
    const data = await request("/auth/session");
    state.user = data.user;
    await signIn({ sessionId: state.sessionId, user: data.user });
  } catch {
    sessionStorage.removeItem("loadngo-session");
    state.sessionId = null;
  }
}

document
  .querySelectorAll(".role-tab")
  .forEach((button) =>
    button.addEventListener("click", () => selectRole(button.dataset.role)),
  );
$("#sendOtpButton").addEventListener("click", sendOtp);
$("#verifyOtpButton").addEventListener("click", verifyOtp);
$("#supplierLoginButton").addEventListener("click", supplierLogin);
$("#showRegisterButton").addEventListener(
  "click",
  () => ($("#registerPanel").hidden = !$("#registerPanel").hidden),
);
$("#registerButton").addEventListener("click", registerSupplier);
$("#shareLocationButton").addEventListener("click", shareLocation);
$("#availabilityToggle").addEventListener("change", async (event) => {
  try {
    await request("/driver/availability", {
      method: "POST",
      body: JSON.stringify({ available: event.target.checked }),
    });
    updateAvailability(event.target.checked);
  } catch (error) {
    event.target.checked = !event.target.checked;
    toast(error.message, "error");
  }
});
$("#refreshDriverButton").addEventListener("click", refreshDriver);
$("#pickupLocationButton").addEventListener("click", choosePickupLocation);
$("#loadForm").addEventListener("submit", createLoad);
$("#refreshSupplierButton").addEventListener("click", refreshSupplier);
$("#clearRejectedButton")?.addEventListener("click", clearRejectedLoads);
document
  .querySelectorAll(".logout-button")
  .forEach((button) => button.addEventListener("click", logout));
$("#requiredAt").value = defaultDateTime();
restoreSession();
