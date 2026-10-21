
const express = require("express");
const mongoose = require("mongoose");
const cookieParser = require("cookie-parser");
const helmet = require("helmet");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const path = require("path");

const app = express();

app.use(helmet({
  contentSecurityPolicy: false
}));
app.use(express.json({ limit: "20kb" }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const JWT_SECRET = process.env.JWT_SECRET;

const hospitalSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  slug: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true
  },
  city: { type: String, required: true, trim: true },
  phone: { type: String, default: "" },
  active: { type: Boolean, default: true }
}, { timestamps: true });

const userSchema = new mongoose.Schema({
  hospitalId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Hospital",
    default: null
  },
  name: { type: String, required: true },
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true
  },
  passwordHash: { type: String, required: true },
  role: {
    type: String,
    enum: ["superadmin", "hospital_admin"],
    required: true
  },
  active: { type: Boolean, default: true }
}, { timestamps: true });

const doctorSchema = new mongoose.Schema({
  hospitalId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Hospital",
    required: true,
    index: true
  },
  name: { type: String, required: true, trim: true },
  specialty: { type: String, required: true, trim: true },
  fee: { type: Number, required: true, min: 0 },
  days: [{
    type: Number,
    min: 0,
    max: 6
  }],
  startTime: { type: String, default: "09:00" },
  endTime: { type: String, default: "17:00" },
  slotMinutes: { type: Number, default: 30, min: 10, max: 120 },
  active: { type: Boolean, default: true }
}, { timestamps: true });

const appointmentSchema = new mongoose.Schema({
  hospitalId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Hospital",
    required: true,
    index: true
  },
  doctorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Doctor",
    required: true
  },
  patientName: { type: String, required: true, trim: true },
  patientPhone: { type: String, required: true, trim: true },
  date: { type: String, required: true },
  time: { type: String, required: true },
  status: {
    type: String,
    enum: ["pending", "confirmed", "cancelled", "completed"],
    default: "pending"
  }
}, { timestamps: true });

appointmentSchema.index({
  hospitalId: 1,
  doctorId: 1,
  date: 1,
  time: 1,
  status: 1
});

const Hospital = mongoose.model("Hospital", hospitalSchema);
const User = mongoose.model("User", userSchema);
const Doctor = mongoose.model("Doctor", doctorSchema);
const Appointment = mongoose.model("Appointment", appointmentSchema);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false
});

function makeToken(user) {
  return jwt.sign({
    id: user._id.toString(),
    role: user.role,
    hospitalId: user.hospitalId
      ? user.hospitalId.toString()
      : null
  }, JWT_SECRET, { expiresIn: "8h" });
}

function auth(req, res, next) {
  try {
    const token = req.cookies.cc_token;
    if (!token) {
      return res.status(401).json({ error: "Please log in." });
    }

    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Session expired. Log in again." });
  }
}

function superadminOnly(req, res, next) {
  if (req.user.role !== "superadmin") {
    return res.status(403).json({ error: "Superadmin access required." });
  }
  next();
}

function hospitalAdminOnly(req, res, next) {
  if (req.user.role !== "hospital_admin") {
    return res.status(403).json({ error: "Hospital admin access required." });
  }
  next();
}

function validDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const d = new Date(`${date}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) &&
    d.toISOString().slice(0, 10) === date;
}

function validTime(time) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(time);
}

function makeSlots(doctor, date) {
  if (!validDate(date)) return [];

  const day = new Date(`${date}T00:00:00`).getDay();
  if (!doctor.days.includes(day)) return [];

  const [startH, startM] = doctor.startTime.split(":").map(Number);
  const [endH, endM] = doctor.endTime.split(":").map(Number);
  let current = startH * 60 + startM;
  const end = endH * 60 + endM;
  const slots = [];

  while (current + doctor.slotMinutes <= end) {
    slots.push(
      `${String(Math.floor(current / 60)).padStart(2, "0")}:${String(current % 60).padStart(2, "0")}`
    );
    current += doctor.slotMinutes;
  }

  return slots;
}

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    app: "CardioCare AI",
    database: mongoose.connection.readyState === 1
      ? "connected"
      : "disconnected"
  });
});

app.post("/api/auth/login", loginLimiter, async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");

  const user = await User.findOne({ email, active: true });
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    return res.status(401).json({ error: "Invalid email or password." });
  }

  res.cookie("cc_token", makeToken(user), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 8 * 60 * 60 * 1000,
    path: "/"
  });

  res.json({
    ok: true,
    user: {
      name: user.name,
      email: user.email,
      role: user.role,
      hospitalId: user.hospitalId
    }
  });
});

app.post("/api/auth/logout", (req, res) => {
  res.clearCookie("cc_token", { path: "/" });
  res.json({ ok: true });
});

app.get("/api/auth/me", auth, async (req, res) => {
  const user = await User.findById(req.user.id)
    .select("name email role hospitalId active");

  if (!user || !user.active) {
    return res.status(401).json({ error: "Account unavailable." });
  }

  res.json({ user });
});

app.get("/api/hospitals", async (req, res) => {
  const hospitals = await Hospital.find({ active: true })
    .select("name slug city phone")
    .sort({ name: 1 });

  res.json({ hospitals });
});

app.get("/api/hospitals/:slug/doctors", async (req, res) => {
  const hospital = await Hospital.findOne({
    slug: req.params.slug.toLowerCase(),
    active: true
  });

  if (!hospital) {
    return res.status(404).json({ error: "Hospital not found." });
  }

  const doctors = await Doctor.find({
    hospitalId: hospital._id,
    active: true
  }).select("name specialty fee days startTime endTime slotMinutes");

  res.json({ hospital, doctors });
});

app.get("/api/hospitals/:slug/slots", async (req, res) => {
  const hospital = await Hospital.findOne({
    slug: req.params.slug.toLowerCase(),
    active: true
  });

  if (!hospital) {
    return res.status(404).json({ error: "Hospital not found." });
  }

  const doctor = await Doctor.findOne({
    _id: req.query.doctorId,
    hospitalId: hospital._id,
    active: true
  });

  if (!doctor || !validDate(String(req.query.date || ""))) {
    return res.status(400).json({ error: "Invalid doctor or date." });
  }

  const allSlots = makeSlots(doctor, req.query.date);
  const booked = await Appointment.find({
    hospitalId: hospital._id,
    doctorId: doctor._id,
    date: req.query.date,
    status: { $in: ["pending", "confirmed"] }
  }).select("time");

  const bookedTimes = new Set(booked.map(a => a.time));
  res.json({
    slots: allSlots.filter(time => !bookedTimes.has(time))
  });
});

app.post("/api/appointments", loginLimiter, async (req, res) => {
  const hospitalSlug = String(req.body.hospitalSlug || "").toLowerCase();
  const doctorId = String(req.body.doctorId || "");
  const patientName = String(req.body.patientName || "").trim();
  const patientPhone = String(req.body.patientPhone || "").trim();
  const date = String(req.body.date || "");
  const time = String(req.body.time || "");

  if (
    !hospitalSlug ||
    !mongoose.isValidObjectId(doctorId) ||
    patientName.length < 2 ||
    patientName.length > 100 ||
    !/^[+\d ()-]{7,20}$/.test(patientPhone) ||
    !validDate(date) ||
    !validTime(time)
  ) {
    return res.status(400).json({ error: "Please check the appointment details." });
  }

  const hospital = await Hospital.findOne({
    slug: hospitalSlug,
    active: true
  });

  if (!hospital) {
    return res.status(404).json({ error: "Hospital not found." });
  }

  const doctor = await Doctor.findOne({
    _id: doctorId,
    hospitalId: hospital._id,
    active: true
  });

  if (!doctor || !makeSlots(doctor, date).includes(time)) {
    return res.status(400).json({ error: "This doctor is not available at that time." });
  }

  const alreadyBooked = await Appointment.findOne({
    hospitalId: hospital._id,
    doctorId: doctor._id,
    date,
    time,
    status: { $in: ["pending", "confirmed"] }
  });

  if (alreadyBooked) {
    return res.status(409).json({ error: "This slot is already booked." });
  }

  const appointment = await Appointment.create({
    hospitalId: hospital._id,
    doctorId: doctor._id,
    patientName,
    patientPhone,
    date,
    time
  });

  res.status(201).json({
    ok: true,
    message: "Appointment request received.",
    appointmentId: appointment._id
  });
});

app.post("/api/platform/hospitals", auth, superadminOnly, async (req, res) => {
  const name = String(req.body.name || "").trim();
  const slug = String(req.body.slug || "").trim().toLowerCase();
  const city = String(req.body.city || "").trim();
  const phone = String(req.body.phone || "").trim();
  const adminName = String(req.body.adminName || "").trim();
  const adminEmail = String(req.body.adminEmail || "").trim().toLowerCase();
  const adminPassword = String(req.body.adminPassword || "");

  if (
    name.length < 2 ||
    !/^[a-z0-9-]{3,50}$/.test(slug) ||
    city.length < 2 ||
    adminName.length < 2 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail) ||
    adminPassword.length < 12
  ) {
    return res.status(400).json({
      error: "Check hospital details. Admin password must be at least 12 characters."
    });
  }

  if (await User.findOne({ email: adminEmail })) {
    return res.status(409).json({ error: "Admin email already exists." });
  }

  const session = await mongoose.startSession();

  try {
    let createdHospital;
    await session.withTransaction(async () => {
      [createdHospital] = await Hospital.create([{
        name, slug, city, phone
      }], { session });

      const passwordHash = await bcrypt.hash(adminPassword, 12);

      await User.create([{
        hospitalId: createdHospital._id,
        name: adminName,
        email: adminEmail,
        passwordHash,
        role: "hospital_admin"
      }], { session });
    });

    res.status(201).json({
      ok: true,
      hospital: createdHospital
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({
        error: "Hospital slug or admin email already exists."
      });
    }
    throw error;
  } finally {
    await session.endSession();
  }
});

app.post("/api/admin/doctors", auth, hospitalAdminOnly, async (req, res) => {
  const name = String(req.body.name || "").trim();
  const specialty = String(req.body.specialty || "").trim();
  const fee = Number(req.body.fee);
  const startTime = String(req.body.startTime || "09:00");
  const endTime = String(req.body.endTime || "17:00");
  const slotMinutes = Number(req.body.slotMinutes || 30);
  const days = req.body.days;

  if (
    name.length < 2 ||
    specialty.length < 2 ||
    !Number.isFinite(fee) ||
    fee < 0 ||
    !validTime(startTime) ||
    !validTime(endTime) ||
    startTime >= endTime ||
    !Number.isInteger(slotMinutes) ||
    slotMinutes < 10 ||
    slotMinutes > 120 ||
    !Array.isArray(days) ||
    days.some(day => !Number.isInteger(day) || day < 0 || day > 6)
  ) {
    return res.status(400).json({ error: "Invalid doctor details." });
  }

  const doctor = await Doctor.create({
    hospitalId: req.user.hospitalId,
    name,
    specialty,
    fee,
    startTime,
    endTime,
    slotMinutes,
    days
  });

  res.status(201).json({ ok: true, doctor });
});

app.get("/api/admin/doctors", auth, hospitalAdminOnly, async (req, res) => {
  const doctors = await Doctor.find({
    hospitalId: req.user.hospitalId
  }).sort({ name: 1 });

  res.json({ doctors });
});

app.get("/api/admin/appointments", auth, hospitalAdminOnly, async (req, res) => {
  const appointments = await Appointment.find({
    hospitalId: req.user.hospitalId
  }).populate("doctorId", "name specialty fee")
    .sort({ date: -1, time: 1 })
    .limit(200);

  res.json({ appointments });
});

app.patch("/api/admin/appointments/:id", auth, hospitalAdminOnly, async (req, res) => {
  const allowed = ["pending", "confirmed", "cancelled", "completed"];
  const status = String(req.body.status || "");

  if (!allowed.includes(status)) {
    return res.status(400).json({ error: "Invalid appointment status." });
  }

  const appointment = await Appointment.findOneAndUpdate(
    {
      _id: req.params.id,
      hospitalId: req.user.hospitalId
    },
    { status },
    { new: true, runValidators: true }
  );

  if (!appointment) {
    return res.status(404).json({ error: "Appointment not found." });
  }

  res.json({ ok: true, appointment });
});

app.post("/api/voice/session", async (req, res) => {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return res.status(503).json({
      error: "AI voice is not configured yet."
    });
  }

  try {
    const response = await fetch(
      "https://api.openai.com/v1/realtime/client_secrets",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          session: {
            type: "realtime",
            model: "gpt-realtime-2.1",
            instructions:
              "You are CardioCare AI, a friendly hospital appointment information assistant. Speak clearly and briefly. You can explain how to request an appointment, but you cannot diagnose medical conditions or claim an appointment is booked. Direct the user to the appointment form to submit a real request."
          }
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error("OpenAI voice session error:", data);
      return res.status(502).json({
        error: "Could not start the AI voice session."
      });
    }

    res.json(data);
  } catch (error) {
    console.error("Voice session request failed:", error);
    res.status(502).json({ error: "AI voice service unavailable." });
  }
});

app.get("/admin.html", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

app.use("/api", (req, res) => {
  res.status(404).json({ error: "API route not found." });
});

app.use((error, req, res, next) => {
  console.error(error);
  if (res.headersSent) return next(error);
  res.status(500).json({ error: "Internal server error." });
});

async function bootstrapSuperadmin() {
  const email = process.env.BOOTSTRAP_SUPERADMIN_EMAIL;
  const password = process.env.BOOTSTRAP_SUPERADMIN_PASSWORD;

  if (!email || !password) {
    console.log("Superadmin bootstrap skipped: environment variables not set.");
    return;
  }

  const normalizedEmail = email.trim().toLowerCase();
  const existing = await User.findOne({ email: normalizedEmail });

  if (existing) {
    console.log("Superadmin account already exists.");
    return;
  }

  if (password.length < 16) {
    throw new Error("Superadmin password must be at least 16 characters.");
  }

  await User.create({
    name: "Platform Superadmin",
    email: normalizedEmail,
    passwordHash: await bcrypt.hash(password, 12),
    role: "superadmin"
  });

  console.log("Superadmin account created.");
}

async function start() {
  if (!MONGODB_URI) throw new Error("MONGODB_URI is not configured.");
  if (!JWT_SECRET || JWT_SECRET.length < 32) {
    throw new Error("JWT_SECRET must be at least 32 characters.");
  }

  await mongoose.connect(MONGODB_URI);
  await bootstrapSuperadmin();

  app.listen(PORT, () => {
    console.log(`CardioCare AI server running on port ${PORT}`);
  });
}

start().catch(error => {
  console.error("Failed to start CardioCare AI:", error);
  process.exit(1);
});
