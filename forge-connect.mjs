#!/usr/bin/env node

import { createHash, webcrypto } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir, hostname, platform } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import readline from "node:readline";

const { subtle } = webcrypto;
const stateDirectory = process.env.FORGE_CONNECT_HOME || join(homedir(), ".forge-connect");
const statePath = join(stateDirectory, "devices.json");

function base64Url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function loadState() {
  try {
    const parsed = JSON.parse(await readFile(statePath, "utf8"));
    return parsed?.version === 1 && Array.isArray(parsed.devices)
      ? parsed
      : { version: 1, devices: [] };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return { version: 1, devices: [] };
  }
}

async function saveState(state) {
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const temporary = `${statePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, statePath);
}

function parsePairingUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "forgeconnect:" || url.hostname !== "pair") {
    throw new Error("Expected a forgeconnect://pair link from Forge Arena");
  }
  const origin = new URL(url.searchParams.get("origin") || "");
  const allowedProductionOrigins = new Set([
    "https://arena.timeprooflabs.com",
    "https://bios-arena-fe1.midniteblue6180.workers.dev",
  ]);
  const localDevelopment =
    origin.protocol === "http:" &&
    (origin.hostname === "127.0.0.1" || origin.hostname === "localhost");
  if (!allowedProductionOrigins.has(origin.origin) && !localDevelopment) {
    throw new Error("This pairing link is not from an approved Forge Arena origin");
  }
  const token = url.searchParams.get("token") || "";
  if (!/^pair_[a-f0-9]+\.[A-Za-z0-9_-]{32,}$/.test(token)) {
    throw new Error("The pairing link is malformed or incomplete");
  }
  return { origin: origin.origin, token };
}

async function pair(value) {
  const { origin, token } = parsePairingUrl(value);
  const keys = await subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  );
  const [publicKeyJwk, privateKeyJwk] = await Promise.all([
    subtle.exportKey("jwk", keys.publicKey),
    subtle.exportKey("jwk", keys.privateKey),
  ]);
  const proofBytes = await subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    keys.privateKey,
    Buffer.from(`FORGE-PAIR-V1\n${token}`)
  );
  const pairingId = token.slice(0, token.indexOf("."));
  const response = await fetch(`${origin}/api/pairings/${encodeURIComponent(pairingId)}/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token,
      publicKeyJwk,
      proof: base64Url(proofBytes),
      deviceLabel: `Forge Connect on ${hostname()}`,
    }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.message || result.error || `Pairing failed (${response.status})`);

  const state = await loadState();
  state.devices = state.devices.filter((device) => device.deviceId !== result.deviceId);
  state.devices.unshift({
    deviceId: result.deviceId,
    projectId: result.projectId,
    sessionId: result.sessionId,
    endpoint: result.endpoint,
    scopes: result.scopes,
    privateKeyJwk,
    counter: 0,
    pairedAt: new Date().toISOString(),
  });
  await saveState(state);
  process.stderr.write(
    `Forge Connect paired project ${result.projectId}.\nConfigure your agent to run: forge-connect mcp\n`
  );
}

async function signRequest(device, bodyText) {
  const key = await subtle.importKey(
    "jwk",
    device.privateKeyJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
  const endpoint = new URL(process.env.FORGE_CONNECT_ENDPOINT || device.endpoint);
  const timestamp = String(Date.now());
  const counter = String(device.counter + 1);
  const message = [
    "FORGE-MCP-V1",
    "POST",
    `${endpoint.pathname}${endpoint.search}`,
    timestamp,
    counter,
    sha256Hex(bodyText),
  ].join("\n");
  const signature = await subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    Buffer.from(message)
  );
  return {
    counter: Number(counter),
    endpoint: endpoint.href,
    headers: {
      "Content-Type": "application/json",
      "X-Forge-Device": device.deviceId,
      "X-Forge-Timestamp": timestamp,
      "X-Forge-Counter": counter,
      "X-Forge-Signature": base64Url(signature),
    },
  };
}

async function runMcp(deviceId) {
  const state = await loadState();
  const device = deviceId
    ? state.devices.find((candidate) => candidate.deviceId === deviceId)
    : state.devices[0];
  if (!device) throw new Error("No paired Forge device. Click Connect Agent in Forge Arena first.");

  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      JSON.parse(line);
      const signed = await signRequest(device, line);
      // Persist before sending. The server accepts counter gaps, so a dropped
      // response can never strand the device on a replayed counter.
      device.counter = signed.counter;
      await saveState(state);
      const response = await fetch(signed.endpoint, {
        method: "POST",
        headers: signed.headers,
        body: line,
      });
      const responseText = await response.text();
      if (responseText) process.stdout.write(`${responseText}\n`);
      if (!response.ok) {
        process.stderr.write(`Forge Arena rejected request (${response.status}).\n`);
      }
    } catch (error) {
      process.stdout.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
        })}\n`
      );
    }
  }
}

function installProtocolHandler() {
  if (platform() !== "win32") {
    throw new Error(
      "Automatic one-click registration is currently available on Windows. On macOS/Linux, pass the pairing link directly to forge-connect."
    );
  }
  const scriptPath = fileURLToPath(import.meta.url);
  const command = `\"${process.execPath}\" \"${scriptPath}\" \"%1\"`;
  const entries = [
    ["HKCU\\Software\\Classes\\forgeconnect", ["/ve", "/d", "URL:Forge Connect Protocol", "/f"]],
    ["HKCU\\Software\\Classes\\forgeconnect", ["/v", "URL Protocol", "/d", "", "/f"]],
    ["HKCU\\Software\\Classes\\forgeconnect\\DefaultIcon", ["/ve", "/d", process.execPath, "/f"]],
    ["HKCU\\Software\\Classes\\forgeconnect\\shell\\open\\command", ["/ve", "/d", command, "/f"]],
  ];
  for (const [key, args] of entries) {
    const result = spawnSync("reg.exe", ["add", key, ...args], {
      stdio: "pipe",
      encoding: "utf8",
    });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout || "Could not register protocol");
  }
  process.stderr.write("Forge Connect one-click links are installed for this Windows account.\n");
}

async function main() {
  const [command, argument] = process.argv.slice(2);
  if (command?.startsWith("forgeconnect://")) return pair(command);
  if (command === "pair" && argument) return pair(argument);
  if (command === "install") return installProtocolHandler();
  if (command === "mcp") return runMcp(argument);
  if (command === "devices") {
    const state = await loadState();
    process.stdout.write(
      `${JSON.stringify(
        state.devices.map(({ privateKeyJwk: _privateKeyJwk, ...device }) => device),
        null,
        2
      )}\n`
    );
    return;
  }
  process.stderr.write(
    "Forge Connect\n\n  forge-connect install\n  forge-connect <forgeconnect://pair?...>\n  forge-connect mcp [device-id]\n  forge-connect devices\n"
  );
}

main().catch((error) => {
  process.stderr.write(`Forge Connect: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

