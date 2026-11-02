import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./image-attachments.ts");
}

const image = { type: "image", mimeType: "image/png", data: "YWJj" };

test("calculates padded base64 byte lengths and rejects invalid data", async () => {
  const { getBase64DecodedByteLength } = await loadSubject();

  assert.equal(getBase64DecodedByteLength("YQ=="), 1);
  assert.equal(getBase64DecodedByteLength("YWI="), 2);
  assert.equal(getBase64DecodedByteLength("YWJj"), 3);
  assert.equal(getBase64DecodedByteLength("not base64!"), null);
});

test("rejects invalid, oversized, and too many image attachments", async () => {
  const { MAX_ATTACHED_IMAGE_BYTES, MAX_ATTACHED_IMAGES, validateAgentImages } = await loadSubject();
  const oversizedData = "AAAA".repeat(Math.ceil((MAX_ATTACHED_IMAGE_BYTES + 1) / 3));

  assert.equal(validateAgentImages([image]), null);
  assert.match(validateAgentImages([{ ...image, mimeType: "text/plain" }]), /valid base64 image/);
  assert.match(validateAgentImages([{ ...image, data: oversizedData }]), /10MB/);
  assert.match(validateAgentImages(Array.from({ length: MAX_ATTACHED_IMAGES + 1 }, () => image)), /at most/);
});

test("extracts editable base64 images from both stored image shapes", async () => {
  const { extractBase64ImageAttachment } = await loadSubject();

  assert.deepEqual(
    extractBase64ImageAttachment({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "YWJj" },
    }),
    { data: "YWJj", mimeType: "image/png" },
  );
  assert.deepEqual(
    extractBase64ImageAttachment({ type: "image", data: "YWJj", mimeType: "image/jpeg" }),
    { data: "YWJj", mimeType: "image/jpeg" },
  );
  assert.equal(
    extractBase64ImageAttachment({ type: "image", source: { type: "url", url: "https://example.com/a.png" } }),
    null,
  );
});

test("compresses only oversized non-GIF files", async () => {
  const { CLIENT_IMAGE_COMPRESSION_THRESHOLD_BYTES, shouldCompressImageFile } = await loadSubject();
  assert.equal(shouldCompressImageFile({ size: CLIENT_IMAGE_COMPRESSION_THRESHOLD_BYTES, type: "image/png" }), false);
  assert.equal(shouldCompressImageFile({ size: CLIENT_IMAGE_COMPRESSION_THRESHOLD_BYTES + 1, type: "image/png" }), true);
  assert.equal(shouldCompressImageFile({ size: CLIENT_IMAGE_COMPRESSION_THRESHOLD_BYTES + 1, type: "image/gif" }), false);
});
