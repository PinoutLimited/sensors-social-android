import { ApiPromise, WsProvider } from "@polkadot/api";
import { u8aToHex } from "@polkadot/util";
import { CID } from "multiformats/cid";
import { ROOT_META, profileMeta } from "./index.js";
const enc = (v) => new TextEncoder().encode(JSON.stringify(v));
const api = await ApiPromise.create({ provider: new WsProvider("wss://polkadot.rpc.robonomics.network/"), noInitWarn: true });
const E = Math.floor(Date.now()/1000);
const r = (await (await fetch(`https://roseman.robonomics.network/api/v2/sensor/markers/${E-3600}/${E}`)).json()).result;
let owner, sensor;
for (const m of r) { if (!m.owner || !m.sensor_id) continue; const d = (await api.query.rws.devices(m.owner)).map(String); if (d.includes(m.owner) && d.includes(m.sensor_id)) { owner = m.owner; sensor = m.sensor_id; break; } }
const cid = CID.parse("bafkreibnjwdiwglbadjq2ltodanyfydsyaynoqrmnqbgm5t3qp5z6u7kea");
const meta = enc(profileMeta(sensor));
const calls = {
  createRoot: api.tx.cps.createNode(null, u8aToHex(enc(ROOT_META)), null, { identity: owner, permit: null }),
  createSensorNode: api.tx.cps.createNode(7, u8aToHex(meta), null, null),
  setPayload: api.tx.cps.setPayload(7, u8aToHex(cid.bytes)),
};
for (const [name, c] of Object.entries(calls)) {
  const tx = api.tx.rws.call(owner, c);
  const info = await tx.paymentInfo(owner);
  console.log(name.padEnd(16), "call", tx.method.toU8a().length, "B; weight", info.weight.refTime.toString(), "; class", info.class.toString());
}
// round-trip: the meta and payload bytes decode back exactly
const back = api.createType("Call", calls.createSensorNode.method.toU8a()).args[1].unwrap().toU8a(true);
console.log("meta round-trip equal:", u8aToHex(back) === u8aToHex(meta), "|", new TextDecoder().decode(back).slice(0, 30) + "…");
const back2 = api.createType("Call", calls.setPayload.method.toU8a()).args[1].unwrap().toU8a(true);
console.log("payload decodes to CID:", CID.decode(back2).toString() === cid.toString());
await api.disconnect();
