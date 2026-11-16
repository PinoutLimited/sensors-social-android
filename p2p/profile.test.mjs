// node --test p2p/  — pure parts of the profile publisher.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildProfileDocument, findSensorNode, profileMeta, ROOT_META } from "./index.js";

const SENSOR = "4TestSensorAddressForProfiLeSpecs1111111111111111";

test("profile.json matches what RoSeMAN validates", () => {
  const doc = buildProfileDocument(SENSOR, "  Балкон, 5 этаж  ", ["bafkreia", "bafkreib"]);
  assert.deepEqual(doc, {
    v: 1,
    sensor: SENSOR,
    description: "Балкон, 5 этаж",
    images: ["ipfs://bafkreia", "ipfs://bafkreib"],
  });
});

test("description limit counts characters, not bytes", () => {
  assert.equal(buildProfileDocument(SENSOR, "ж".repeat(500), []).description.length, 500);
  assert.throws(() => buildProfileDocument(SENSOR, "ж".repeat(501), []), /500/);
});

test("at most three photos", () => {
  assert.throws(() => buildProfileDocument(SENSOR, "", ["a", "b", "c", "d"]), /3 photos/);
});

test("finds the sensor's node among the owner's children", () => {
  const children = [
    { id: "8", meta: JSON.stringify(profileMeta("4OtherSensor")) },
    { id: "9", meta: "not json" },
    { id: "10", meta: JSON.stringify(profileMeta(SENSOR)) },
  ];
  assert.equal(findSensorNode(children, SENSOR), "10");
  assert.equal(findSensorNode(children, "4Missing"), null);
});

test("meta fits CPS limits (≤1 KiB) and matches the RoSeMAN parser", () => {
  const meta = JSON.stringify(profileMeta(SENSOR));
  assert.ok(new TextEncoder().encode(meta).length <= 1024);
  assert.deepEqual(JSON.parse(meta), { t: "ss.profile", v: 1, sensor: SENSOR });
  assert.deepEqual(ROOT_META, { t: "ss.profiles", v: 1 });
});
