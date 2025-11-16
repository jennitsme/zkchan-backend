// src/server.js (ESM, no helmet)
import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";
import { Connection, PublicKey } from "@solana/web3.js";
import { ethers } from "ethers";

dotenv.config();

// ---------- CORS ----------
const corsOriginsEnv = process.env.CORS_ORIGIN || "";
const allowedOrigins = corsOriginsEnv
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const app = express();

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
 *   errorMessage?: string,
 *   evmTxHash?: string
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

function requireEnv(name, msg) {
  const val = process.env[name];
  if (!val) {
    throw new Error(msg || `Missing env var: ${name}`);
  }
  return val;
}

// ---------- Routes ----------
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    network: "zkchan-bridge",
    time: new Date().toISOString(),
  });
});

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

app.get("/bridge/job/:id", (req, res) => {
  const job = jobs[req.params.id];
  if (!job) {
    return res.status(404).json({ error: "Job not found" });
  }
  res.json(job);
});

// OPTIONAL: manual payout trigger
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

  const enableEvmSend = process.env.ENABLE_EVM_SEND === "true";

  try {
    updateJob(jobId, { status: "executing" });

    if (!enableEvmSend) {
      console.log(
        "[bridge] Simulated EVM payout for job",
        jobId,
        "to",
        job.request.receiver,
        "amount",
        job.request.amount
      );
      updateJob(jobId, { status: "completed" });
      return res.json({
        jobId,
        status: "completed",
        simulated: true,
      });
    }

    const rpcUrl = requireEnv(
      "EVM_RPC_URL",
      "EVM_RPC_URL is required when ENABLE_EVM_SEND=true"
    );
    const pk = requireEnv(
      "EVM_PRIVATE_KEY",
      "EVM_PRIVATE_KEY is required when ENABLE_EVM_SEND=true"
    );
    const decimals = Number(process.env.EVM_NATIVE_DECIMALS || "18");

    const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
    const wallet = new ethers.Wallet(pk, provider);

    const amountStr = String(job.request.amount || "0");
    const valueWei = ethers.utils.parseUnits(amountStr, decimals);

    const tx = await wallet.sendTransaction({
      to: job.request.receiver,
      value: valueWei,
    });

    console.log("[bridge] Sent EVM tx", tx.hash, "for job", jobId);

    updateJob(jobId, {
      status: "completed",
      evmTxHash: tx.hash,
    });

    res.json({
      jobId,
      status: "completed",
      evmTxHash: tx.hash,
      simulated: false,
    });
  } catch (err) {
    console.error("[bridge] execute error:", err);
    updateJob(jobId, {
      status: "failed",
      errorMessage: err.message || String(err),
    });
    res.status(500).json({ error: "Failed to execute EVM payout" });
  }
});

// ---------- Start server ----------
const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`zkChan backend listening on port ${port}`);
});
