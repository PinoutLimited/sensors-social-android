// sensors.social app — sensor profile publishing (bundled to www/vendor/p2p.js, global SSP2P).
//
// Flow: photos → JPEG ≤1280 px without EXIF → this phone becomes an IPFS node (Helia) and
// holds the photos + profile.json → it dials our Kubo over WebSocket → the owner signs
// rws.call(owner, cps.setPayload(profileNode, CID)) → RoSeMAN sees the CPS event and asks
// Kubo to pin the CID; Kubo pulls the blocks from this phone over bitswap → profile "ready".
//
// The owner's secret phrase is used for signing in memory only and is never stored.

import { createHelia } from "helia";
import { unixfs } from "@helia/unixfs";
import { webSockets } from "@libp2p/websockets";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { identify } from "@libp2p/identify";
import { multiaddr } from "@multiformats/multiaddr";
import { MemoryBlockstore } from "blockstore-core";
import { MemoryDatastore } from "datastore-core";
import { ApiPromise, WsProvider } from "@polkadot/api";
import { Keyring } from "@polkadot/keyring";
import { cryptoWaitReady, mnemonicValidate } from "@polkadot/util-crypto";
import { u8aToHex, u8aToString } from "@polkadot/util";

export const ROOT_META = { t: "ss.profiles", v: 1 };
export const profileMeta = (sensor) => ({ t: "ss.profile", v: 1, sensor });
export const MAX_DESCRIPTION = 500;
export const MAX_IMAGES = 3;
const MAX_SIDE = 1280;
const JPEG_QUALITY = 0.8;

const enc = (v) => new TextEncoder().encode(JSON.stringify(v));
// polkadot.js reads a raw Uint8Array as already SCALE-encoded (length prefix);
// pass byte arguments of extrinsics as hex so they are taken as the value itself.
const bytesArg = (u8) => u8aToHex(u8);

/** Photo → JPEG ≤1280 px. Re-encoding through a canvas drops EXIF, GPS included. */
export async function prepareImage(file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d").drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", JPEG_QUALITY));
  return { blob, width: w, height: h };
}

/** profile.json as stored on IPFS (ERC-721-like). Pure, unit-tested. */
export function buildProfileDocument(sensor, description, imageCids) {
  const text = String(description || "").trim();
  if ([...text].length > MAX_DESCRIPTION) throw new Error(`Description is longer than ${MAX_DESCRIPTION} characters`);
  if (imageCids.length > MAX_IMAGES) throw new Error(`At most ${MAX_IMAGES} photos`);
  return { v: 1, sensor, description: text, images: imageCids.map((c) => `ipfs://${c}`) };
}

/** Finds the child node whose meta names this sensor. */
export function findSensorNode(children, sensor) {
  for (const { id, meta } of children) {
    try {
      const m = JSON.parse(meta);
      if (m && m.t === "ss.profile" && m.sensor === sensor) return id;
    } catch {}
  }
  return null;
}

async function startNode() {
  const helia = await createHelia({
    libp2p: {
      transports: [webSockets()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      services: { identify: identify() },
    },
    blockstore: new MemoryBlockstore(),
    datastore: new MemoryDatastore(),
    routers: [],
  });
  await helia.start(); // registers /ipfs/bitswap — without it Kubo has no one to ask
  return helia;
}

function signAndWait(api, tx, pair) {
  return new Promise((resolve, reject) => {
    let unsub = null;
    tx.signAndSend(pair, (r) => {
      if (r.dispatchError) {
        let msg = r.dispatchError.toString();
        if (r.dispatchError.isModule) {
          const d = api.registry.findMetaError(r.dispatchError.asModule);
          msg = `${d.section}.${d.name}`;
        }
        unsub?.();
        reject(new Error(msg));
        return;
      }
      if (r.status.isInBlock) {
        // A direct call fails with ExtrinsicFailed; rws.call reports the inner result in rws.NewCall.
        const failed = r.events.find(({ event }) => event.section === "system" && event.method === "ExtrinsicFailed");
        if (failed) {
          const err = failed.event.data[0];
          let msg = err.toString();
          if (err.isModule) {
            const d = api.registry.findMetaError(err.asModule);
            msg = `${d.section}.${d.name}`;
          }
          unsub?.();
          reject(new Error(msg));
          return;
        }
        const inner = r.events.find(({ event }) => event.section === "rws" && event.method === "NewCall");
        const result = inner?.event.data[1];
        if (result && result.isErr) {
          const err = result.asErr;
          let msg = err.toString();
          if (err.isModule) {
            const d = api.registry.findMetaError(err.asModule);
            msg = `${d.section}.${d.name}`;
          }
          unsub?.();
          reject(new Error(msg));
          return;
        }
        unsub?.();
        resolve(r);
      }
    })
      .then((u) => (unsub = u))
      .catch(reject);
  });
}

async function readChildren(api, parentId) {
  const ids = (await api.query.cps.children(parentId)).map((x) => x.toString());
  const out = [];
  for (const id of ids) {
    const m = await api.query.cps.meta(id);
    out.push({ id, meta: m.isSome ? u8aToString(m.unwrap().toU8a(true)) : "" });
  }
  return out;
}

function createdNodeId(result) {
  const ev = result.events.find(({ event }) => event.section === "cps" && event.method === "NodeCreated");
  return ev ? ev.event.data[0].toString() : null;
}

/**
 * Publishes a sensor profile. Resolves when RoSeMAN reports it ready (or rejects).
 * opts: { mnemonic, sensor, description, photos: [Blob], keepImages: [cid], rpc, kubo, profileApi, onStatus }
 */
export async function publishProfile(opts) {
  const say = (t) => opts.onStatus?.(t);
  const phrase = String(opts.mnemonic || "").trim().split(/\s+/).join(" ");
  await cryptoWaitReady();
  if (!mnemonicValidate(phrase)) throw new Error("The secret phrase is not valid");
  const pair = new Keyring({ type: "sr25519", ss58Format: 32 }).addFromMnemonic(phrase);
  const owner = pair.address;

  say("Connecting to Robonomics…");
  const api = await ApiPromise.create({ provider: new WsProvider(opts.rpc), noInitWarn: true });
  let helia = null;
  try {
    const devices = (await api.query.rws.devices(owner)).map((d) => d.toString());
    if (!devices.includes(opts.sensor)) {
      throw new Error("This secret phrase is not the owner of this sensor (the sensor is not in its subscription)");
    }
    // With an RWS subscription the owner writes for free through rws.call (the owner must be one
    // of its own devices). Without one, the CPS calls are sent directly and the owner pays the
    // fee in XRT — a fraction of a milli-XRT each.
    const ledger = await api.query.rws.ledger(owner);
    const free = ledger.isSome && devices.includes(owner);
    if (!free) {
      const balance = (await api.query.system.account(owner)).data.free.toBigInt();
      if (balance < 10_000_000n) throw new Error("The owner account has no RWS subscription and less than 0.01 XRT for fees");
    }
    const viaRws = (call) => (free ? api.tx.rws.call(owner, call) : call);

    // 1. Owner's profiles root (identity = owner, so it can be found by address).
    let root = await api.query.cps.identityNode(owner);
    let rootId = root.isSome ? root.unwrap().toString() : null;
    if (!rootId) {
      say("Creating your profiles node on Robonomics…");
      const r = await signAndWait(
        api,
        viaRws(api.tx.cps.createNode(null, bytesArg(enc(ROOT_META)), null, { identity: owner, permit: null })),
        pair
      );
      rootId = createdNodeId(r);
      if (!rootId) throw new Error("Profiles node was not created");
    }

    // 2. This sensor's profile node.
    let nodeId = findSensorNode(await readChildren(api, rootId), opts.sensor);
    if (!nodeId) {
      say("Creating the sensor's profile node…");
      const r = await signAndWait(
        api,
        viaRws(api.tx.cps.createNode(rootId, bytesArg(enc(profileMeta(opts.sensor))), null, null)),
        pair
      );
      nodeId = createdNodeId(r);
      if (!nodeId) throw new Error("Profile node was not created");
    }

    // 3. Photos and profile.json into this phone's IPFS node.
    say("Preparing photos…");
    helia = await startNode();
    const fs = unixfs(helia);
    // Photos already in the shown profile are pinned on our Kubo: keep them by CID.
    const imageCids = [...(opts.keepImages || [])];
    for (const blob of opts.photos) {
      const cid = await fs.addBytes(new Uint8Array(await blob.arrayBuffer()));
      imageCids.push(cid.toV1().toString());
    }
    const doc = buildProfileDocument(opts.sensor, opts.description, imageCids);
    const profileCid = (await fs.addBytes(enc(doc))).toV1();

    say("Connecting to the sensors.social IPFS node…");
    await helia.libp2p.dial(multiaddr(opts.kubo), { signal: AbortSignal.timeout(20000) });

    // 4. Point the node at the new profile.
    say("Signing the profile on Robonomics…");
    await signAndWait(api, viaRws(api.tx.cps.setPayload(nodeId, bytesArg(profileCid.bytes))), pair);

    // 5. Keep serving blocks until RoSeMAN has pinned them.
    say("Uploading photos — keep the app open…");
    const target = profileCid.toString();
    const deadline = Date.now() + 5 * 60 * 1000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 4000));
      try {
        const res = await fetch(`${opts.profileApi}v2/profile/${opts.sensor}`, { cache: "no-store" });
        const p = (await res.json()).result;
        if (p && p.status === "ready" && !p.pending_cid) return { profileCid: target, nodeId, images: p.images };
        if (p && p.status === "failed" && (p.pending_cid === target || !p.pending_cid)) {
          throw new Error(`The server rejected the profile: ${p.error || "unknown error"}`);
        }
      } catch (e) {
        if (String(e.message).startsWith("The server rejected")) throw e;
      }
    }
    throw new Error("The server did not confirm the upload in 5 minutes. Open the app and try again.");
  } finally {
    await helia?.stop().catch(() => {});
    await api.disconnect().catch(() => {});
  }
}
