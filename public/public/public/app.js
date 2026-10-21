
const $ = (selector) => document.querySelector(selector);

const hospitalList = $("#hospitalList");
const hospitalSelect = $("#hospitalSelect");
const doctorSelect = $("#doctorSelect");
const visitDate = $("#visitDate");
const timeSelect = $("#timeSelect");
const appointmentForm = $("#appointmentForm");
const appointmentMessage = $("#appointmentMessage");
const voiceButton = $("#voiceButton");
const voiceStart = $("#voiceStart");
const voiceStop = $("#voiceStop");
const voiceStatus = $("#voiceStatus");

let hospitals = [];
let doctors = [];
let voicePeer = null;
let voiceStream = null;
let voiceChannel = null;

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {})
    }
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || "Request failed. Please try again.");
  }

  return data;
}

function showMessage(element, message, isError = false) {
  if (!element) return;

  element.textContent = message;
  element.style.color = isError ? "#b42318" : "";
}

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
}

function resetDoctors(message = "Choose a doctor") {
  doctorSelect.innerHTML =
    `<option value="">${escapeHTML(message)}</option>`;
  doctorSelect.disabled = true;

  timeSelect.innerHTML = '<option value="">Choose a time</option>';
  timeSelect.disabled = true;

  doctors = [];
}

function resetTimes(message = "Choose a time") {
  timeSelect.innerHTML =
    `<option value="">${escapeHTML(message)}</option>`;
  timeSelect.disabled = true;
}

async function loadHospitals() {
  try {
    const data = await api("/api/hospitals");
    hospitals = data.hospitals || [];

    hospitalSelect.innerHTML =
      '<option value="">Choose a hospital</option>';

    hospitals.forEach((hospital) => {
      const option = document.createElement("option");
      option.value = hospital.slug;
      option.textContent = `${hospital.name} — ${hospital.city}`;
      hospitalSelect.appendChild(option);
    });

    if (!hospitals.length) {
      hospitalList.innerHTML = `
        <div class="empty-state">
          <h3>No hospitals listed yet</h3>
          <p>Hospitals will appear here after they are added by the platform administrator.</p>
        </div>`;
      return;
    }

    hospitalList.innerHTML = hospitals.map((hospital) => `
      <article class="hospital-card">
        <h3>${escapeHTML(hospital.name)}</h3>
        <p>${escapeHTML(hospital.city)}</p>
        <p>${hospital.phone
          ? `Contact: ${escapeHTML(hospital.phone)}`
          : "Explore doctors and available appointment times."}</p>
        <button class="button button-primary choose-hospital"
          type="button"
          data-slug="${escapeHTML(hospital.slug)}">
          Explore doctors <span>→</span>
        </button>
      </article>
    `).join("");
  } catch (error) {
    hospitalList.innerHTML = `
      <div class="empty-state">
        <h3>Hospitals couldn't load</h3>
        <p>${escapeHTML(error.message)}</p>
        <button class="button button-secondary" id="retryHospitals" type="button">
          Try again
        </button>
      </div>`;
  }
}

hospitalList.addEventListener("click", async (event) => {
  const button = event.target.closest(".choose-hospital");
  if (!button) return;

  hospitalSelect.value = button.dataset.slug;
  $("#appointment").scrollIntoView({ behavior: "smooth" });

  await loadDoctors(button.dataset.slug);
});

$("#retryHospitals")?.addEventListener("click", loadHospitals);

async function loadDoctors(slug) {
  resetDoctors("Loading doctors…");

  if (!slug) {
    resetDoctors();
    return;
  }

  try {
    const data = await api(
      `/api/hospitals/${encodeURIComponent(slug)}/doctors`
    );

    doctors = data.doctors || [];
    doctorSelect.innerHTML = '<option value="">Choose a doctor</option>';

    doctors.forEach((doctor) => {
      const option = document.createElement("option");
      option.value = doctor._id;
      option.textContent =
        `${doctor.name} — ${doctor.specialty} (₹${doctor.fee})`;
      doctorSelect.appendChild(option);
    });

    doctorSelect.disabled = doctors.length === 0;

    if (!doctors.length) {
      doctorSelect.innerHTML =
        '<option value="">No doctors listed yet</option>';
    }
  } catch (error) {
    resetDoctors("Could not load doctors");
    showMessage(appointmentMessage, error.message, true);
  }
}

hospitalSelect.addEventListener("change", () => {
  loadDoctors(hospitalSelect.value);
});

async function loadSlots() {
  resetTimes("Loading times…");

  const slug = hospitalSelect.value;
  const doctorId = doctorSelect.value;
  const date = visitDate.value;

  if (!slug || !doctorId || !date) {
    resetTimes();
    return;
  }

  try {
    const data = await api(
      `/api/hospitals/${encodeURIComponent(slug)}/slots` +
      `?doctorId=${encodeURIComponent(doctorId)}` +
      `&date=${encodeURIComponent(date)}`
    );

    timeSelect.innerHTML = '<option value="">Choose a time</option>';

    (data.slots || []).forEach((time) => {
      const option = document.createElement("option");
      option.value = time;
      option.textContent = time;
      timeSelect.appendChild(option);
    });

    timeSelect.disabled = !(data.slots || []).length;

    if (!(data.slots || []).length) {
      timeSelect.innerHTML =
        '<option value="">No available times</option>';
    }
  } catch (error) {
    resetTimes("Could not load times");
    showMessage(appointmentMessage, error.message, true);
  }
}

doctorSelect.addEventListener("change", loadSlots);
visitDate.addEventListener("change", loadSlots);

function setMinimumDate() {
  const now = new Date();
  const localDate = new Date(
    now.getTime() - now.getTimezoneOffset() * 60000
  ).toISOString().slice(0, 10);

  visitDate.min = localDate;

  if (!visitDate.value || visitDate.value < localDate) {
    visitDate.value = localDate;
  }
}

appointmentForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  showMessage(appointmentMessage, "Submitting your appointment request…");

  const payload = {
    hospitalSlug: hospitalSelect.value,
    doctorId: doctorSelect.value,
    date: visitDate.value,
    time: timeSelect.value,
    patientName: $("#patientName").value.trim(),
    patientPhone: $("#patientPhone").value.trim()
  };

  try {
    const data = await api("/api/appointments", {
      method: "POST",
      body: JSON.stringify(payload)
    });

    showMessage(
      appointmentMessage,
      `${data.message} Request reference: ${data.appointmentId}. The hospital must confirm your appointment.`
    );

    timeSelect.value = "";
    await loadSlots();
  } catch (error) {
    showMessage(appointmentMessage, error.message, true);
    await loadSlots();
  }
});

async function startVoice() {
  if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) {
    showMessage(
      voiceStatus,
      "Voice calling needs a supported browser and a secure HTTPS connection.",
      true
    );
    return;
  }

  if (!window.isSecureContext) {
    showMessage(
      voiceStatus,
      "Open the deployed website using HTTPS to enable the microphone.",
      true
    );
    return;
  }

  voiceStart.disabled = true;
  showMessage(voiceStatus, "Connecting to the AI voice assistant…");

  try {
    const session = await api("/api/voice/session", {
      method: "POST",
      body: JSON.stringify({})
    });

    const ephemeralKey =
      session.client_secret?.value ||
      session.value ||
      session.client_secret;

    if (typeof ephemeralKey !== "string") {
      throw new Error("The voice service did not return a usable session key.");
    }

    voiceStream = await navigator.mediaDevices.getUserMedia({
      audio: true
    });

    voicePeer = new RTCPeerConnection();

    voiceStream.getTracks().forEach((track) => {
      voicePeer.addTrack(track, voiceStream);
    });

    voicePeer.ontrack = (event) => {
      let audio = $("#voiceAudio");

      if (!audio) {
        audio = document.createElement("audio");
        audio.id = "voiceAudio";
        audio.autoplay = true;
        document.body.appendChild(audio);
      }

      audio.srcObject = event.streams[0];
      audio.play().catch(() => {
        showMessage(voiceStatus, "Tap the page to allow audio playback.");
      });
    };

    voiceChannel = voicePeer.createDataChannel("oai-events");

    voiceChannel.onopen = () => {
      showMessage(
        voiceStatus,
        "Connected. Ask general questions about the platform or appointment process."
      );

      voiceChannel.send(JSON.stringify({
        type: "session.update",
        session: {
          instructions:
            "You are CardioCare AI, a friendly hospital appointment information assistant. Speak clearly and briefly. You can explain how to request an appointment, but you cannot diagnose medical conditions or claim an appointment is booked. Direct the user to the appointment form to submit a real request."
        }
      }));
    };

    voiceChannel.onmessage = (event) => {
      let message;

      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }

      if (message.type === "error") {
        showMessage(
          voiceStatus,
          message.error?.message || "The voice assistant returned an error.",
          true
        );
      }
    };

    const offer = await voicePeer.createOffer();
    await voicePeer.setLocalDescription(offer);

    const sdpResponse = await fetch(
      "https://api.openai.com/v1/realtime/calls",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ephemeralKey}`,
          "Content-Type": "application/sdp"
        },
        body: offer.sdp
      }
    );

    if (!sdpResponse.ok) {
      throw new Error("Could not connect the voice call. Please try again.");
    }

    const answerSdp = await sdpResponse.text();

    await voicePeer.setRemoteDescription({
      type: "answer",
      sdp: answerSdp
    });

    voiceStart.hidden = true;
    voiceStop.hidden = false;
  } catch (error) {
    await stopVoice(false);
    showMessage(voiceStatus, error.message, true);
  } finally {
    voiceStart.disabled = false;
  }
}

async function stopVoice(showStatus = true) {
  if (voiceChannel) {
    voiceChannel.close();
    voiceChannel = null;
  }

  if (voicePeer) {
    voicePeer.close();
    voicePeer = null;
  }

  if (voiceStream) {
    voiceStream.getTracks().forEach((track) => track.stop());
    voiceStream = null;
  }

  const audio = $("#voiceAudio");
  if (audio) {
    audio.pause();
    audio.srcObject = null;
    audio.remove();
  }

  voiceStart.hidden = false;
  voiceStop.hidden = true;
  voiceStart.disabled = false;

  if (showStatus) {
    showMessage(voiceStatus, "Voice conversation ended.");
  }
}

voiceStart.addEventListener("click", startVoice);
voiceStop.addEventListener("click", () => stopVoice());
voiceButton.addEventListener("click", () => {
  $("#voiceAssistant").scrollIntoView({ behavior: "smooth" });
  startVoice();
});

setMinimumDate();
loadHospitals();
