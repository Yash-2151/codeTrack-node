const fs = require("fs");
const path = require("path");
const express = require("express");
const { MongoClient } = require("mongodb");

function loadEnvFile(filename) {
  const envPath = path.join(__dirname, filename);
  if (!fs.existsSync(envPath)) return false;

  // Keep env loading dependency-free so the same file works in local dev
  // and in simple classroom/demo environments without extra setup.
  const content = fs.readFileSync(envPath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) continue;

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if (!key || process.env[key]) continue;
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }

  return true;
}

loadEnvFile(".env");

const app = express();
const PORT = Number(process.env.PORT || 3001);
const MONGODB_URI = String(process.env.MONGODB_URI || "").trim();
const DB_NAME = process.env.MONGODB_DB || "codetrack";
const TEACHER_ROLE = "pro";
const STUDENT_ROLE = "user";

let client;
let db;
let initPromise;

function isAllowedOrigin(origin = "") {
  return (
    /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin) ||
    /^https:\/\/[a-z0-9-]+\.vercel\.app$/.test(origin)
  );
}

app.use((req, res, next) => {
  const origin = String(req.headers.origin || "");

  if (origin && isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-CodeTrack-Email, X-CodeTrack-Role");
  }

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, ".")));

// Centralizing collection access keeps route handlers concise once the
// database connection has been established.
const collections = () => ({
  counters: db.collection("counters"),
  users: db.collection("users"),
  loginEvents: db.collection("login_events"),
  contactMessages: db.collection("contact_messages"),
  exercises: db.collection("exercises"),
  submissions: db.collection("submissions"),
  reviewComments: db.collection("review_comments"),
  progressComments: db.collection("progress_comments"),
  progressCommentReads: db.collection("progress_comment_reads"),
  notifications: db.collection("notifications"),
  activityLogs: db.collection("activity_logs")
});

function normalizeRole(role = "") {
  if (role === "teacher") return TEACHER_ROLE;
  if (role === "student") return STUDENT_ROLE;
  return role;
}

async function authenticatedUserFromRequest(req) {
  const email = String(req.headers["x-codetrack-email"] || "").trim().toLowerCase();
  const role = normalizeRole(String(req.headers["x-codetrack-role"] || "").trim());
  if (!email || !role) return null;
  const { users } = collections();
  const user = await users.findOne({ email });
  if (!user || user.role !== role) return null;
  return user;
}

async function requireAuthenticatedUser(req, res) {
  const user = await authenticatedUserFromRequest(req);
  if (!user) {
    res.status(401).json({ error: "Please sign in to continue." });
    return null;
  }
  return user;
}

async function requireRole(req, res, role) {
  const user = await requireAuthenticatedUser(req, res);
  if (!user) return null;
  if (user.role !== role) {
    res.status(403).json({ error: role === TEACHER_ROLE ? "Teacher access required." : "Student access required." });
    return null;
  }
  return user;
}

function storedPasswordForUser(user) {
  if (!user) return "";
  return String(
    user.password ??
    user.passwordHash ??
    user.password_hash ??
    ""
  );
}

function toTimestamp(value) {
  return new Date(value).getTime();
}

function now() {
  return new Date();
}

async function createNotification({
  recipientEmail = "",
  recipientRole = "",
  kind = "info",
  title = "",
  message = "",
  relatedType = "",
  relatedId = null
}) {
  const { notifications } = collections();
  const notification = {
    id: await nextId("notifications"),
    recipientEmail: String(recipientEmail || "").trim().toLowerCase(),
    recipientRole: String(recipientRole || "").trim(),
    kind,
    title,
    message,
    relatedType,
    relatedId,
    readAt: null,
    createdAt: now()
  };
  await notifications.insertOne(notification);
  return notification;
}

async function logActivity({
  actorEmail = "",
  actorRole = "",
  action = "",
  entityType = "",
  entityId = null,
  description = "",
  metadata = {}
}) {
  const { activityLogs } = collections();
  const entry = {
    id: await nextId("activity_logs"),
    actorEmail: String(actorEmail || "").trim().toLowerCase(),
    actorRole: String(actorRole || "").trim(),
    action,
    entityType,
    entityId,
    description,
    metadata,
    createdAt: now()
  };
  await activityLogs.insertOne(entry);
  return entry;
}

async function nextId(name) {
  const { counters } = collections();
  // Each logical collection gets its own monotonic counter so numeric ids stay
  // stable across inserts without relying on Mongo ObjectIds in the UI.
  const result = await counters.findOneAndUpdate(
    { _id: name },
    { $inc: { value: 1 } },
    { upsert: true, returnDocument: "after" }
  );
  const doc = typeof result.value === "number" ? result : result.value || result;
  return Number(doc.value);
}

async function cleanupInvalidIds() {
  const {
    exercises,
    submissions,
    reviewComments,
    progressComments,
    progressCommentReads,
    notifications,
    activityLogs,
    contactMessages,
    users,
    loginEvents
  } = collections();
  const targetCollections = [
    exercises,
    submissions,
    reviewComments,
    progressComments,
    progressCommentReads,
    notifications,
    activityLogs,
    contactMessages,
    users,
    loginEvents
  ];

  for (const collection of targetCollections) {
    // Older seed data may contain malformed ids; removing those rows prevents
    // counters, filters, and route lookups from breaking later on.
    const docs = await collection.find({}, { projection: { _id: 1, id: 1 } }).toArray();
    const badIds = docs.filter((doc) => Number.isNaN(doc.id)).map((doc) => doc._id);
    if (badIds.length) {
      await collection.deleteMany({ _id: { $in: badIds } });
    }
  }
}

async function cleanupLegacyReviewStatus() {
  const { submissions, reviewComments } = collections();

  // Older documents stored a review status field that is no longer part of
  // the product model. Remove it so persisted data matches the current UI/API.
  await Promise.all([
    submissions.updateMany(
      { status: { $exists: true } },
      { $unset: { status: "" } }
    ),
    reviewComments.updateMany(
      { status: { $exists: true } },
      { $unset: { status: "" } }
    )
  ]);
}

async function initDatabase() {
  if (db) return db;
  if (!MONGODB_URI) {
    const envExists = fs.existsSync(path.join(__dirname, ".env"));
    throw new Error(
      envExists
        ? "Missing MONGODB_URI in .env. Add your MongoDB Atlas connection string and restart CodeTrack."
        : "Missing MONGODB_URI. Create a .env file in the project root and add your MongoDB Atlas connection string."
    );
  }

  client = new MongoClient(MONGODB_URI, {
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 10000
  });
  await client.connect();
  db = client.db(DB_NAME);

  const {
    users,
    loginEvents,
    contactMessages,
    exercises,
    submissions,
    reviewComments,
    progressComments,
    progressCommentReads,
    notifications,
    activityLogs
  } = collections();

  await Promise.all([
    users.createIndex({ email: 1 }, { unique: true }),
    loginEvents.createIndex({ userId: 1 }),
    contactMessages.createIndex({ createdAt: -1 }),
    exercises.createIndex({ id: 1 }, { unique: true }),
    submissions.createIndex({ id: 1 }, { unique: true }),
    submissions.createIndex({ exerciseId: 1, studentEmail: 1 }),
    reviewComments.createIndex({ id: 1 }, { unique: true }),
    reviewComments.createIndex({ submissionId: 1 }),
    progressComments.createIndex({ id: 1 }, { unique: true }),
    progressComments.createIndex({ studentEmail: 1, exerciseId: 1 }),
    progressCommentReads.createIndex({ id: 1 }, { unique: true }),
    progressCommentReads.createIndex({ commentId: 1, studentEmail: 1 }, { unique: true }),
    notifications.createIndex({ id: 1 }, { unique: true }),
    notifications.createIndex({ recipientEmail: 1, createdAt: -1 }),
    notifications.createIndex({ recipientRole: 1, createdAt: -1 }),
    activityLogs.createIndex({ id: 1 }, { unique: true }),
    activityLogs.createIndex({ actorEmail: 1, createdAt: -1 }),
    activityLogs.createIndex({ entityType: 1, entityId: 1 })
  ]);

  await cleanupInvalidIds();
  await cleanupLegacyReviewStatus();
  await seedDatabase();
  await ensureDefaultAccounts();
  return db;
}

async function seedDatabase() {
  // Leave the exercise collections empty on startup so teachers control
  // when exercises first appear in both the UI and the database.
  return;
}

async function ensureDefaultAccounts() {
  const { users } = collections();
  const defaultUsers = [
    {
      email: "teacher@gmail.com",
      password: "teacher123",
      role: "pro",
      fullName: "Priya Instructor"
    },
    {
      email: "maya@gmail.com",
      password: "student123",
      role: "user",
      fullName: "Maya Sharma"
    }
  ];

  for (const defaultUser of defaultUsers) {
    const existingUser = await users.findOne({ email: defaultUser.email });
    if (existingUser) continue;

    await users.insertOne({
      id: await nextId("users"),
      email: defaultUser.email,
      password: defaultUser.password,
      role: defaultUser.role,
      fullName: defaultUser.fullName,
      lastLoginAt: null,
      createdAt: new Date()
    });
  }
}

async function readState(viewer = null) {
  const { exercises, submissions, reviewComments, progressComments, progressCommentReads, notifications, activityLogs } = collections();
  const [exerciseRows, submissionRows, reviewRows, progressCommentRows, progressCommentReadRows, notificationRows, activityRows] = await Promise.all([
    exercises.find().sort({ createdAt: -1, id: -1 }).toArray(),
    submissions.find().sort({ createdAt: 1, id: 1 }).toArray(),
    reviewComments.find().sort({ createdAt: 1, id: 1 }).toArray(),
    progressComments.find().sort({ createdAt: 1, id: 1 }).toArray(),
    progressCommentReads.find().sort({ seenAt: 1, id: 1 }).toArray(),
    notifications.find().sort({ createdAt: -1, id: -1 }).limit(100).toArray(),
    activityLogs.find().sort({ createdAt: -1, id: -1 }).limit(150).toArray()
  ]);

  const viewerRole = viewer?.role || "";
  const viewerEmail = String(viewer?.email || "").toLowerCase();
  const visibleSubmissionRows =
    viewerRole === TEACHER_ROLE
      ? submissionRows
      : viewerRole === STUDENT_ROLE
        ? submissionRows.filter((row) => String(row.studentEmail || "").toLowerCase() === viewerEmail)
        : [];
  const visibleSubmissionIds = new Set(visibleSubmissionRows.map((row) => row.id));
  const visibleReviewRows =
    viewerRole === TEACHER_ROLE
      ? reviewRows
      : reviewRows.filter((row) => visibleSubmissionIds.has(row.submissionId));
  const visibleProgressCommentRows =
    viewerRole === TEACHER_ROLE
      ? progressCommentRows
      : viewerRole === STUDENT_ROLE
        ? progressCommentRows.filter((row) => String(row.studentEmail || "").toLowerCase() === viewerEmail)
        : [];
  const visibleProgressCommentReadRows =
    viewerRole === TEACHER_ROLE
      ? progressCommentReadRows
      : viewerRole === STUDENT_ROLE
        ? progressCommentReadRows.filter((row) => String(row.studentEmail || "").toLowerCase() === viewerEmail)
        : [];
  const visibleNotificationRows =
    viewerRole
      ? notificationRows.filter(
          (row) =>
            String(row.recipientEmail || "").toLowerCase() === viewerEmail ||
            (!row.recipientEmail && row.recipientRole === viewerRole)
        )
      : [];
  const visibleActivityRows =
    viewerRole === TEACHER_ROLE
      ? activityRows
      : viewerRole === STUDENT_ROLE
        ? activityRows.filter((row) => String(row.actorEmail || "").toLowerCase() === viewerEmail)
        : [];

  const reviewsBySubmission = visibleReviewRows.reduce((acc, row) => {
    const review = {
      id: row.id,
      instructorName: row.instructorName,
      comment: row.comment,
      scoreOverride: row.scoreOverride ?? null,
      createdAt: toTimestamp(row.createdAt)
    };
    acc[row.submissionId] = acc[row.submissionId] || [];
    acc[row.submissionId].push(review);
    return acc;
  }, {});

  return {
    exercises: exerciseRows.map((row) => ({
      id: row.id,
      title: row.title,
      language: row.language,
      difficulty: row.difficulty,
      prompt: row.prompt,
      createdAt: toTimestamp(row.createdAt)
    })),
    submissions: visibleSubmissionRows.map((row) => {
      const reviews = reviewsBySubmission[row.id] || [];
      const latestReview = reviews[reviews.length - 1];
      return {
        id: row.id,
        exerciseId: row.exerciseId,
        studentName: row.studentName,
        studentEmail: row.studentEmail,
        code: row.code,
        notes: row.notes || "",
        attempt: row.attempt,
        score: latestReview?.scoreOverride ?? row.score,
        latestComment: latestReview?.comment || "",
        reviews,
        createdAt: toTimestamp(row.createdAt)
      };
    }),
    progressComments: visibleProgressCommentRows.map((row) => ({
      id: row.id,
      studentEmail: row.studentEmail,
      exerciseId: row.exerciseId ?? null,
      authorRole: row.authorRole,
      authorName: row.authorName,
      comment: row.comment,
      editedAt: row.editedAt ? toTimestamp(row.editedAt) : null,
      createdAt: toTimestamp(row.createdAt)
    })),
    progressCommentReads: visibleProgressCommentReadRows.map((row) => ({
      id: row.id,
      commentId: row.commentId,
      studentEmail: row.studentEmail,
      seenAt: toTimestamp(row.seenAt)
    })),
    notifications: visibleNotificationRows.map((row) => ({
      id: row.id,
      recipientEmail: row.recipientEmail || "",
      recipientRole: row.recipientRole || "",
      kind: row.kind,
      title: row.title,
      message: row.message,
      relatedType: row.relatedType || "",
      relatedId: row.relatedId ?? null,
      readAt: row.readAt ? toTimestamp(row.readAt) : null,
      createdAt: toTimestamp(row.createdAt)
    })),
    activityLogs: visibleActivityRows.map((row) => ({
      id: row.id,
      actorEmail: row.actorEmail || "",
      actorRole: row.actorRole || "",
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId ?? null,
      description: row.description,
      metadata: row.metadata || {},
      createdAt: toTimestamp(row.createdAt)
    })),
    meta: {
      totalExercises: exerciseRows.length,
      totalSubmissions: visibleSubmissionRows.length,
      totalReviews: visibleReviewRows.length,
      totalUsers: new Set(visibleSubmissionRows.map((row) => row.studentEmail)).size
    }
  };
}

app.get("/api/state", async (req, res) => {
  try {
    const viewer = await authenticatedUserFromRequest(req);
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.json(await readState(viewer));
  } catch (error) {
    res.status(500).json({ error: "Could not load database state.", details: error.message });
  }
});

app.post("/api/exercises", async (req, res) => {
  const actor = await requireRole(req, res, TEACHER_ROLE);
  if (!actor) return;
  const title = String(req.body.title || "").trim();
  const language = String(req.body.language || "").trim();
  const difficulty = String(req.body.difficulty || "").trim();
  const prompt = String(req.body.prompt || "").trim();

  if (!title || !language || !difficulty || !prompt) {
    return res.status(400).json({ error: "Title, language, difficulty, and prompt are required." });
  }

  try {
    const { exercises } = collections();
    const exercise = {
      id: await nextId("exercises"),
      title,
      language,
      difficulty,
      prompt,
      createdAt: new Date()
    };
    await exercises.insertOne(exercise);
    await logActivity({
      actorEmail: actor.email,
      actorRole: actor.role,
      action: "exercise_created",
      entityType: "exercise",
      entityId: exercise.id,
      description: `Exercise created: ${title}`,
      metadata: { language, difficulty }
    });
    res.status(201).json({ ...exercise, createdAt: toTimestamp(exercise.createdAt) });
  } catch (error) {
    res.status(500).json({ error: "Could not save exercise.", details: error.message });
  }
});

app.post("/api/submissions", async (req, res) => {
  const actor = await requireRole(req, res, STUDENT_ROLE);
  if (!actor) return;
  const exerciseId = Number(req.body.exerciseId);
  const studentName = String(req.body.studentName || "").trim() || String(actor.fullName || "").trim() || "Student";
  const studentEmail = actor.email;
  const code = String(req.body.code || "").trim();
  const notes = String(req.body.notes || "").trim();

  if (!exerciseId || !studentName || !studentEmail || !code) {
    return res.status(400).json({ error: "Exercise, student details, and code are required." });
  }

  try {
    const { exercises, submissions } = collections();
    const exercise = await exercises.findOne({ id: exerciseId });
    if (!exercise) return res.status(404).json({ error: "Exercise not found." });

    const attempt = (await submissions.countDocuments({ exerciseId, studentEmail })) + 1;
    const submission = {
      id: await nextId("submissions"),
      exerciseId,
      studentName,
      studentEmail,
      code,
      notes,
      attempt,
      score: null, // Score will be set by teacher review
      createdAt: new Date()
    };

    await submissions.insertOne(submission);
    await logActivity({
      actorEmail: studentEmail,
      actorRole: "user",
      action: "submission_created",
      entityType: "submission",
      entityId: submission.id,
      description: `${studentName} submitted attempt ${attempt}`,
      metadata: { exerciseId, attempt }
    });
    await createNotification({
      recipientRole: "pro",
      kind: "submission",
      title: "New student submission",
      message: `${studentName} submitted attempt ${attempt} for "${exercise.title}".`,
      relatedType: "submission",
      relatedId: submission.id
    });
    res.status(201).json({
      ...submission,
      latestComment: "",
      reviews: [],
      createdAt: toTimestamp(submission.createdAt)
    });
  } catch (error) {
    res.status(500).json({ error: "Could not save submission.", details: error.message });
  }
});

app.patch("/api/submissions/:id/review", async (req, res) => {
  const actor = await requireRole(req, res, TEACHER_ROLE);
  if (!actor) return;
  const submissionId = Number(req.params.id);
  const comment = String(req.body.comment || "").trim();
  const instructorName = String(req.body.instructorName || actor.fullName || "Instructor").trim() || "Instructor";
  const scoreOverride = req.body.scoreOverride == null || req.body.scoreOverride === "" ? null : Number(req.body.scoreOverride);

  if (!submissionId) {
    return res.status(400).json({ error: "Invalid review update." });
  }

  try {
    const { submissions, reviewComments } = collections();
    const submission = await submissions.findOne({ id: submissionId });
    if (!submission) return res.status(404).json({ error: "Submission not found." });

    const scoreValue = Number.isFinite(scoreOverride) ? scoreOverride : null;
    const updatePayload = {};
    if (scoreValue != null) {
      updatePayload.score = scoreValue;
    }

    if (Object.keys(updatePayload).length) {
      await submissions.updateOne({ id: submissionId }, { $set: updatePayload });
    }
    await reviewComments.insertOne({
      id: await nextId("review_comments"),
      submissionId,
      instructorName,
      comment,
      scoreOverride: scoreValue,
      createdAt: new Date()
    });
    await logActivity({
      actorEmail: actor.email,
      actorRole: actor.role,
      action: "submission_reviewed",
      entityType: "submission",
      entityId: submissionId,
      description: `Submission ${submissionId} reviewed`,
      metadata: { scoreOverride: scoreValue }
    });
    await createNotification({
      recipientEmail: submission.studentEmail,
      recipientRole: "user",
      kind: "review",
      title: "Your submission was reviewed",
      message: `A teacher left feedback on attempt ${submission.attempt}.`,
      relatedType: "submission",
      relatedId: submissionId
    });

    const state = await readState(actor);
    res.json(state.submissions.find((item) => item.id === submissionId));
  } catch (error) {
    res.status(500).json({ error: "Could not save review.", details: error.message });
  }
});

app.post("/api/contact", async (req, res) => {
  const name = String(req.body.name || "").trim();
  const email = String(req.body.email || "").trim();
  const reason = String(req.body.reason || "").trim();
  const message = String(req.body.message || "").trim();

  if (!name || !email || !reason || !message) {
    return res.status(400).json({ error: "All contact fields are required." });
  }

  try {
    const { contactMessages } = collections();
    const contact = { id: await nextId("contact_messages"), name, email, reason, message, createdAt: new Date() };
    await contactMessages.insertOne(contact);
    await logActivity({
      actorEmail: email,
      action: "contact_message_created",
      entityType: "contact_message",
      entityId: contact.id,
      description: `Contact message submitted for ${reason}`,
      metadata: { name, reason }
    });
    res.status(201).json({ id: contact.id, status: "saved" });
  } catch (error) {
    res.status(500).json({ error: "Could not save message.", details: error.message });
  }
});

app.post("/api/progress-comments", async (req, res) => {
  const actor = await requireAuthenticatedUser(req, res);
  if (!actor) return;
  const studentEmail = String(req.body.studentEmail || "").trim().toLowerCase();
  const exerciseId = req.body.exerciseId === null || req.body.exerciseId === "" || req.body.exerciseId === "all"
    ? null
    : Number(req.body.exerciseId);
  const authorRole = actor.role;
  const authorName = String(req.body.authorName || actor.fullName || "").trim() || (authorRole === TEACHER_ROLE ? "Teacher" : "Student");
  const comment = String(req.body.comment || "").trim();

  if (!studentEmail || !comment) {
    return res.status(400).json({ error: "Student email and comment are required." });
  }

  if (authorRole === STUDENT_ROLE && studentEmail !== actor.email) {
    return res.status(403).json({ error: "Students can only comment on their own progress." });
  }

  try {
    const { exercises, progressComments } = collections();
    if (exerciseId !== null && !(await exercises.findOne({ id: exerciseId }))) {
      return res.status(404).json({ error: "Exercise not found for this comment." });
    }

    const progressComment = {
      id: await nextId("progress_comments"),
      studentEmail,
      exerciseId,
      authorRole,
      authorEmail: actor.email,
      authorName,
      comment,
      editedAt: null,
      createdAt: new Date()
    };

    await progressComments.insertOne(progressComment);
    await logActivity({
      actorEmail: actor.email,
      actorRole: authorRole,
      action: "progress_comment_created",
      entityType: "progress_comment",
      entityId: progressComment.id,
      description: `${authorRole === "pro" ? "Teacher" : "Student"} comment added on progress thread`,
      metadata: { studentEmail, exerciseId }
    });
    await createNotification({
      recipientEmail: authorRole === "pro" ? studentEmail : "",
      recipientRole: authorRole === "pro" ? "user" : "pro",
      kind: "comment",
      title: authorRole === "pro" ? "New teacher comment" : "Student replied on progress",
      message: authorRole === "pro"
        ? "A teacher added a new comment to your progress thread."
        : "A student replied in the progress discussion.",
      relatedType: "progress_comment",
      relatedId: progressComment.id
    });
    res.status(201).json({ ...progressComment, createdAt: toTimestamp(progressComment.createdAt) });
  } catch (error) {
    res.status(500).json({ error: "Could not save progress comment.", details: error.message });
  }
});

app.patch("/api/progress-comments/:id", async (req, res) => {
  const actor = await requireAuthenticatedUser(req, res);
  if (!actor) return;
  const commentId = Number(req.params.id);
  const comment = String(req.body.comment || "").trim();
  const authorRole = actor.role;

  if (!commentId || !comment) {
    return res.status(400).json({ error: "Comment id and updated text are required." });
  }

  try {
    const { progressComments } = collections();
    const existing = await progressComments.findOne({ id: commentId });
    if (!existing) return res.status(404).json({ error: "Progress comment not found." });
    if (existing.authorRole !== authorRole) {
      return res.status(403).json({ error: "You can only edit comments created by the same role." });
    }
    if (authorRole === STUDENT_ROLE && String(existing.authorEmail || existing.studentEmail || "").toLowerCase() !== actor.email) {
      return res.status(403).json({ error: "You can only edit your own comments." });
    }

    await progressComments.updateOne({ id: commentId }, { $set: { comment, editedAt: new Date() } });
    await logActivity({
      actorEmail: actor.email,
      actorRole: authorRole,
      action: "progress_comment_updated",
      entityType: "progress_comment",
      entityId: commentId,
      description: "Progress comment updated"
    });
    const state = await readState(actor);
    res.json(state.progressComments.find((item) => item.id === commentId));
  } catch (error) {
    res.status(500).json({ error: "Could not update progress comment.", details: error.message });
  }
});

app.delete("/api/progress-comments/:id", async (req, res) => {
  const actor = await requireAuthenticatedUser(req, res);
  if (!actor) return;
  const commentId = Number(req.params.id);
  const authorRole = actor.role;

  if (!commentId) {
    return res.status(400).json({ error: "Comment id is required." });
  }

  try {
    const { progressComments, progressCommentReads } = collections();
    const existing = await progressComments.findOne({ id: commentId });
    if (!existing) return res.status(404).json({ error: "Progress comment not found." });
    if (existing.authorRole !== authorRole) {
      return res.status(403).json({ error: "You can only delete comments created by the same role." });
    }
    if (authorRole === STUDENT_ROLE && String(existing.authorEmail || existing.studentEmail || "").toLowerCase() !== actor.email) {
      return res.status(403).json({ error: "You can only delete your own comments." });
    }

    await progressComments.deleteOne({ id: commentId });
    await progressCommentReads.deleteMany({ commentId });
    await logActivity({
      actorEmail: actor.email,
      actorRole: authorRole,
      action: "progress_comment_deleted",
      entityType: "progress_comment",
      entityId: commentId,
      description: "Progress comment deleted"
    });
    res.json({ status: "deleted", id: commentId });
  } catch (error) {
    res.status(500).json({ error: "Could not delete progress comment.", details: error.message });
  }
});

app.post("/api/progress-comments/read", async (req, res) => {
  const actor = await requireRole(req, res, STUDENT_ROLE);
  if (!actor) return;
  const studentEmail = String(req.body.studentEmail || "").trim().toLowerCase();
  const commentIds = Array.isArray(req.body.commentIds) ? req.body.commentIds.map((id) => Number(id)).filter(Boolean) : [];

  if (!studentEmail || !commentIds.length) {
    return res.status(400).json({ error: "Student email and comment ids are required." });
  }
  if (studentEmail !== actor.email) {
    return res.status(403).json({ error: "Students can only mark their own comments as read." });
  }

  try {
    const { progressCommentReads } = collections();
    for (const commentId of commentIds) {
      const existing = await progressCommentReads.findOne({ commentId, studentEmail });
      if (existing) {
        await progressCommentReads.updateOne({ commentId, studentEmail }, { $set: { seenAt: new Date() } });
      } else {
        await progressCommentReads.insertOne({
          id: await nextId("progress_comment_reads"),
          commentId,
          studentEmail,
          seenAt: new Date()
        });
      }
    }
    await logActivity({
      actorEmail: actor.email,
      actorRole: actor.role,
      action: "progress_comments_read",
      entityType: "progress_comment_reads",
      description: `${commentIds.length} progress comments marked as read`,
      metadata: { commentIds }
    });
    res.json({ status: "ok", count: commentIds.length });
  } catch (error) {
    res.status(500).json({ error: "Could not mark comments as read.", details: error.message });
  }
});

app.post("/api/notifications/read", async (req, res) => {
  const actor = await requireAuthenticatedUser(req, res);
  if (!actor) return;
  const notificationIds = Array.isArray(req.body.notificationIds)
    ? req.body.notificationIds.map((id) => Number(id)).filter(Boolean)
    : [];

  if (!notificationIds.length) {
    return res.status(400).json({ error: "Notification ids are required." });
  }

  try {
    const { notifications } = collections();
    await notifications.updateMany(
      {
        id: { $in: notificationIds },
        $or: [
          { recipientEmail: actor.email },
          { recipientRole: actor.role, recipientEmail: "" }
        ]
      },
      { $set: { readAt: now() } }
    );
    res.json({ status: "ok", count: notificationIds.length });
  } catch (error) {
    res.status(500).json({ error: "Could not mark notifications as read.", details: error.message });
  }
});

app.post("/api/auth", async (req, res) => {
  const mode = String(req.body.mode || "").trim();
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "").trim();
  const role = req.body.role === "pro" ? "pro" : "user";
  const profile = req.body.profile || {};
  const isGmailEmail = /^[^@\s]+@gmail\.com$/i.test(email);

  if (!mode || !email || !password) {
    return res.status(400).json({ error: "Mode, email, and password are required." });
  }

  if (!isGmailEmail) {
    return res.status(400).json({ error: "Email must be a valid Gmail address ending with @gmail.com." });
  }

  if (password.length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters long." });
  }

  try {
    const { users, loginEvents } = collections();
    const existingUser = await users.findOne({ email });

    if (mode === "login") {
      if (!existingUser) {
        return res.status(401).json({ error: "Invalid credentials." });
      }

      if (storedPasswordForUser(existingUser) !== password) {
        return res.status(401).json({ error: "Invalid credentials." });
      }

      if (existingUser.role !== role) {
        return res.status(403).json({
          error: `This account is registered as a ${existingUser.role === "pro" ? "teacher" : "student"}. Please select the correct role.`
        });
      }

      await users.updateOne({ id: existingUser.id }, { $set: { lastLoginAt: new Date() } });
      await loginEvents.insertOne({
        id: await nextId("login_events"),
        userId: existingUser.id,
        role: existingUser.role,
        loggedInAt: new Date()
      });
      await logActivity({
        actorEmail: existingUser.email,
        actorRole: existingUser.role,
        action: "user_login",
        entityType: "user",
        entityId: existingUser.id,
        description: `${existingUser.email} logged in`
      });

      return res.json({
        status: "ok",
        user: {
          id: existingUser.id,
          email: existingUser.email,
          role: existingUser.role,
          fullName: existingUser.fullName || ""
        }
      });
    }

    if (mode === "signup") {
      if (existingUser) {
        return res.status(409).json({ error: "An account with this email already exists." });
      }

      const user = {
        id: await nextId("users"),
        email,
        password,
        role,
        fullName: String(profile.fullName || "").trim(),
        lastLoginAt: null,
        createdAt: new Date()
      };

      await users.insertOne(user);
      await logActivity({
        actorEmail: email,
        actorRole: role,
        action: "user_signup",
        entityType: "user",
        entityId: user.id,
        description: `${email} created a ${role} account`
      });
      await createNotification({
        recipientEmail: email,
        recipientRole: role,
        kind: "account",
        title: "Account created",
        message: "Your CodeTrack account is ready.",
        relatedType: "user",
        relatedId: user.id
      });
      return res.status(201).json({
        status: "created",
        user: {
          id: user.id,
          email,
          role,
          fullName: user.fullName
        }
      });
    }

    res.status(400).json({ error: "Unsupported auth mode." });
  } catch (error) {
    res.status(500).json({ error: "Could not process authentication.", details: error.message });
  }
});

async function ensureDatabase() {
  if (db) return db;
  if (!initPromise) {
    initPromise = initDatabase().catch((error) => {
      initPromise = null;
      throw error;
    });
  }
  return initPromise;
}

async function start() {
  try {
    await ensureDatabase();
    const server = app.listen(PORT, () => {
      console.log(`CodeTrack running on http://localhost:${PORT}`);
      console.log(`Using MongoDB database "${DB_NAME}" through the configured Atlas connection.`);
    });

    server.on("error", (error) => {
      if (error.code === "EADDRINUSE") {
        console.error(`Port ${PORT} is already in use.`);
        console.error(`Stop the existing server or run this app on another port, for example: PORT=3001 node server.js`);
        process.exit(1);
      }

      console.error("Server error:", error.message);
      process.exit(1);
    });
  } catch (error) {
    console.error("Failed to start CodeTrack:", error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  start();
}

app.ready = ensureDatabase;
module.exports = app;
