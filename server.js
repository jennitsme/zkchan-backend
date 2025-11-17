// server.js
// Backend minimal zkChan, sekarang bisa:
// - Simulasi payout (seperti versi lama) jika ENABLE_EVM_SEND=false
// - Kirim native token beneran di EVM jika ENABLE_EVM_SEND=true

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
const ethers = require("ethers");

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
 *   simulated: boolean,
 *   txHash?: string | null,
 *   explorerUrl?: string | null,
 *   errorMessage?: string | null
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
    simulated: false,
    txHash: null,
    explorerUrl: null,
    errorMessage: null,
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

function getEvmConfig() {
  const rpcUrl = process.env.EVM_RPC_URL || "";
  const privateKey = process.env.EVM_PRIVATE_KEY || "";
  const decimalsEnv = process.env.EVM_NATIVE_DECIMALS || "18";
  let decimals = parseInt(decimalsEnv, 10);
  if (!Number.isFinite(decimals) || decimals < 0) {
    decimals = 18;
  }

  const enableSend =
    String(process.env.ENABLE_EVM_SEND || "").toLowerCase() === "true";

  // optional: base explorer URL, misal:
  // https://sepolia.etherscan.io/tx/ atau https://bscscan.com/tx/
  const explorerBase = process.env.EVM_EXPLORER_BASE || "";

  return { rpcUrl, privateKey, decimals, enableSend, explorerBase };
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
      "[bridge/submit] New job:",
      job.id,
      "amount:",
      amount,
      fromChain,
      "->",
      toChain,
      "receiver:",
      receiver
    );

    res.json({
      jobId: job.id,
      status: job.status,
    });
  } catch (err) {
    console.error("[bridge/submit] error:", err);
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

// Manual "execute" endpoint
// - Kalau ENABLE_EVM_SEND=false => simulasi (sama kayak backend lama)
// - Kalau ENABLE_EVM_SEND=true  => kirim native token beneran via EVM
app.post("/bridge/job/:id/execute", async (req, res) => {
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

  const cfg = getEvmConfig();
  const amountStr = String(job.request.amount || "").trim();
  const receiver = job.request.receiver;

  if (!amountStr) {
    const updated = updateJob(jobId, {
      status: "failed",
      errorMessage: "Missing amount in job payload",
    });
    return res.status(400).json({
      jobId: updated.id,
      status: updated.status,
      simulated: updated.simulated,
      error: updated.errorMessage,
    });
  }

  if (!receiver) {
    const updated = updateJob(jobId, {
      status: "failed",
      errorMessage: "Missing receiver in job payload",
    });
    return res.status(400).json({
      jobId: updated.id,
      status: updated.status,
      simulated: updated.simulated,
      error: updated.errorMessage,
    });
  }

  // --- MODE SIMULASI (perilaku lama) ---
  if (!cfg.enableSend) {
    console.log(
      "[bridge/execute] SIMULATED payout for job",
      jobId,
      "to",
      receiver,
      "amount",
      amountStr
    );
    const updated = updateJob(jobId, {
      status: "completed",
      simulated: true,
    });
    return res.json({
      jobId: updated.id,
      status: updated.status,
      simulated: true,
    });
  }

  // --- MODE REAL EVM SEND ---
  if (!cfg.rpcUrl || !cfg.privateKey) {
    const updated = updateJob(jobId, {
      status: "failed",
      errorMessage: "EVM_RPC_URL or EVM_PRIVATE_KEY not configured",
    });
    return res.status(500).json({
      jobId: updated.id,
      status: updated.status,
      simulated: updated.simulated,
      error: updated.errorMessage,
    });
  }

  try {
    console.log(
      "[bridge/execute] Broadcasting REAL payout for job",
      jobId,
      "to",
      receiver,
      "amount",
      amountStr,
      "decimals",
      cfg.decimals
    );

    const provider = new ethers.providers.JsonRpcProvider(cfg.rpcUrl);
    const wallet = new ethers.Wallet(cfg.privateKey, provider);

    // amount => BigNumber sesuai decimals (default 18)
    const value = ethers.utils.parseUnits(amountStr, cfg.decimals);

    updateJob(jobId, { status: "executing" });

    const tx = await wallet.sendTransaction({
      to: receiver,
      value,
    });

    let explorerUrl = null;
    if (cfg.explorerBase) {
      explorerUrl = cfg.explorerBase + tx.hash;
    }

    console.log(
      "[bridge/execute] Sent tx:",
      tx.hash,
      "waiting for confirmation..."
    );

    await tx.wait(1);

    const updated = updateJob(jobId, {
      status: "completed",
      simulated: false,
      txHash: tx.hash,
      explorerUrl,
      errorMessage: null,
    });

    return res.json({
      jobId: updated.id,
      status: updated.status,
      simulated: false,
      txHash: updated.txHash,
      explorerUrl: updated.explorerUrl,
    });
  } catch (err) {
    console.error("[bridge/execute] Error for job", jobId, ":", err);
    const updated = updateJob(jobId, {
      status: "failed",
      simulated: false,
      errorMessage: err.message || String(err),
    });
    return res.status(500).json({
      jobId: updated.id,
      status: updated.status,
      simulated: updated.simulated,
      error: updated.errorMessage,
    });
  }
});

// ---------- Start server ----------
const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`zkChan backend listening on port ${port}`);
});
