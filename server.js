import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import compression from "compression";
import rateLimit from "express-rate-limit";
import { config } from "dotenv";
import { nanoid } from "nanoid";
import { z } from "zod";

config();

/* ---------- Config ---------- */
const PORT = Number(process.env.PORT || 8080);
const APP_NAME = process.env.APP_NAME || "zkChan Backend";
const LOG_FORMAT = process.env.LOG_FORMAT || "dev";
const SESSION_TTL = Number(process.env.SESSION_TTL_SECONDS || 900);   // 15 min
const PROOF_TTL = Number(process.env.PROOF_TTL_SECONDS || 1800);      // 30 min

// CORS
const envOrigins = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);
const allowedOrigins = envOrigins.length ? envOrigins : ["https://zk-chan.fun"];

/* ---------- App ---------- */
const app = express();

app.set("trust proxy", true);
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));
app.use(compression());
app.use(morgan(LOG_FORMAT));
app.use(express.json({ limit: "1mb" }));

app.use(cors({
  origin: function (origin, cb) {
    // Allow no-origin (curl/postman) or exact whitelisted origins.
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error("CORS: origin not allowed"));
  },
  credentials: true
}));

/* ---------- Rate limits ---------- */
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 60s
  max: 120,            // 120 req/min per IP
  standardHeaders: true,
  legacyHeaders: false
});
app.use("/api/", apiLimiter);

/* ---------- In-memory stores with TTL ---------- */
const sessions = new Map(); // sessionId -> { createdAt, merkleRoot, provingKey }
const proofs   = new Map(); // proofId   -> { createdAt, sessionId, bundle }

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.createdAt > SESSION_TTL * 1000) sessions.delete(id);
  }
  for (const [id, p] of proofs) {
    if (now - p.createdAt > PROOF_TTL * 1000) proofs.delete(id);
  }
}, 30 * 1000);

/* ---------- Schemas ---------- */
const ProveBody = z.object({
  sessionId: z.string().min(6),
  publicKey: z.string().min(4),
  payload: z.object({
    id: z.string().min(6),
    ts: z.number().int().positive(),
    fromChain: z.string().min(2),
    toChain: z.string().min(2),
    fromToken: z.string().min(1),
    toToken: z.string().min(1),
    amount: z.number().positive(),
    receiver: z.string().min(8),
    refund: z.string().optional().nullable(),
    memo: z.string().optional().nullable(),
    commitment: z.string().min(4)
  })
});

const SubmitBody = z.object({
  proofId: z.string().min(6),
  proof: z.string().min(4),
  commitment: z.string().min(4),
  nullifier: z.string().min(4),
  network: z.string().min(2),
  mode: z.string().min(2)
});

/* ---------- Routes ---------- */
app.get("/", (_req, res) => {
  res.type("text/plain").send(`${APP_NAME} is running`);
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: APP_NAME, time: new Date().toISOString() });
});

app.post("/api/session", (_req, res) => {
  const sessionId = nanoid();
  const merkleRoot = "0x" + Buffer.from(nanoid(32)).toString("hex");
  const provingKey = "pk-zkchan-v1";
  sessions.set(sessionId, { createdAt: Date.now(), merkleRoot, provingKey });
  res.json({ sessionId, merkleRoot, provingKey, ttlSeconds: SESSION_TTL });
});

app.post("/api/prove", (req, res) => {
  const parsed = ProveBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.message });

  const { sessionId, publicKey, payload } = parsed.data;
  const sess = sessions.get(sessionId);
  if (!sess) return res.status(400).json({ ok: false, error: "Invalid or expired sessionId" });

  // Attach server-side context you may need for proving orchestration.
  const proofId = nanoid();
  const bundle = {
    proofId,
    proof: "0x" + Buffer.from(nanoid(48)).toString("hex"),
    nullifier: "0x" + Buffer.from(nanoid(24)).toString("hex"),
    commitment: payload.commitment,
    publicKey,
    sessionId,
    meta: { createdAt: Date.now(), fromChain: payload.fromChain, toChain: payload.toChain }
  };

  proofs.set(proofId, { createdAt: Date.now(), sessionId, bundle });
  res.json({ ok: true, ...bundle, ttlSeconds: PROOF_TTL });
});

app.post("/api/submit", async (req, res) => {
  const parsed = SubmitBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.message });

  const { proofId } = parsed.data;
  const entry = proofs.get(proofId);
  if (!entry) return res.status(400).json({ ok: false, error: "Unknown or expired proofId" });

  // Here you would submit to a relayer or chain RPC.
  // We acknowledge acceptance and return a transaction reference.
  const txHash = "0x" + Buffer.from(nanoid(32)).toString("hex");
  const explorerUrl = `https://explorer.example/tx/${txHash}`;

  // Optionally clear proof after accept; keeping it here for inspection until TTL sweeper.
  res.json({ ok: true, txHash, explorerUrl, received: entry.bundle });
});

/* ---------- Errors ---------- */
app.use((err, _req, res, _next) => {
  if (err && /CORS/.test(String(err))) {
    return res.status(403).json({ ok: false, error: String(err.message || err) });
  }
  console.error(err);
  res.status(500).json({ ok: false, error: "Internal server error" });
});

/* ---------- Start ---------- */
app.listen(PORT, () => {
  console.log(`[${APP_NAME}] listening on :${PORT}`);
  console.log(`Allowed CORS origins: ${allowedOrigins.join(", ") || "(none)"}`);
});
