// src/server.js
// CommonJS, no helmet, minimal logic

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");

const app = express();

// ---------- CORS ----------
const corsOriginsEnv = process.env.CORS_ORIGIN || "";
const allowedOrigins = corsOriginsEnv
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: allowedOrigins.length ? allowedOrigins : "*",
  })
);

// ---------- Middleware ----------
app.use(express.json());

// ---------- In-memory storage ----------
/**
 * jobs[jobId] = {
 *   id,
 *   status: "pending" | "executing" | "completed" | "failed",
 *   createdAt,
 *   updatedAt,
 *   request: { ...payload from frontend ... },
 *   errorMessage?: string
 * }
 */
const jobs = {};

// ---------- Helpers ----------
function createJob(payload) {
  const id = uuidv4();
  const now = new Date().toISOString();
  const job = {
    id,
    status: "pending",
    createdAt: now,
    updatedAt: now,
    request: payload,
  };
  jobs[id] = job;
  return job;
}

function updateJob(id, updates) {
  const job = jobs[id];
  if (!job) return null;
  Object.assign(job, updates, { updatedAt: new Date().toISOString() });
  return job;
}

// ---------- Routes ----------

// Simple healthcheck
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    network: "zkchan-bridge",
    time: new Date().toISOString(),
  });
});

// Frontend calls this after user does shielded deposit (or simulated)
app.post("/bridge/submit", (req, res) => {
  try {
    const body = req.body || {};

    const {
      mode,
      amount,
      fromChain,
      toChain,
      fromToken,
      toToken,
      receiver,
      refund,
      depositSignature,
      identityCommitment,
      publicKey,
      phantomAddress,
      evmAddress,
    } = body;

    if (!amount || Number(amount) <= 0) {
      return res.status(400).json({ error: "Invalid amount" });
    }
    if (!receiver) {
      return res.status(400).json({ error: "Missing receiver" });
    }
    if (!depositSignature) {
      return res
        .status(400)
        .json({ error: "Missing depositSignature from Solana side" });
    }

    const job = createJob({
      mode,
      amount,
      fromChain,
      toChain,
      fromToken,
      toToken,
      receiver,
      refund,
      depositSignature,
      identityCommitment,
      publicKey,
      phantomAddress,
      evmAddress,
    });

    console.log(
      "[bridge] New job:",
      job.id,
      "amount:",
      amount,
      fromChain,
      "->",
      toChain
    );

    res.json({
      jobId: job.id,
      status: job.status,
    });
  } catch (err) {
    console.error("[bridge] submit error:", err);
    res.status(500).json({ error: "Internal error submitting bridge job" });
  }
});

// Get job status
app.get("/bridge/job/:id", (req, res) => {
  const job = jobs[req.params.id];
  if (!job) {
    return res.status(404).json({ error: "Job not found" });
  }
  res.json(job);
});

// Manual "execute" endpoint (simulated payout)
app.post("/bridge/job/:id/execute", (req, res) => {
  const jobId = req.params.id;
  const job = jobs[jobId];
  if (!job) {
    return res.status(404).json({ error: "Job not found" });
  }

  if (job.status !== "pending") {
    return res
      .status(400)
      .json({ error: `Job is already ${job.status}, cannot execute.` });
  }

  // For now: simulation only, no real EVM send
  console.log(
    "[bridge] Simulated payout for job",
    jobId,
    "to",
    job.request.receiver,
    "amount",
    job.request.amount
  );

  updateJob(jobId, { status: "completed" });

  res.json({
    jobId,
    status: "completed",
    simulated: true,
  });
});

// ---------- Start server ----------
const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`zkChan backend listening on port ${port}`);
});
