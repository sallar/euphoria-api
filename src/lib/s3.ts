import { S3Client } from "bun";

export type PresignedDownloadUrlInput = {
  bucket: string;
  key: string;
  expiresIn?: number;
};

export type ProfilePhotoObjectInput = {
  objectBucket: string;
  objectKey: string;
  expiresIn?: number;
};

const defaultDownloadUrlExpiresIn = 15 * 60;

const readEnv = (...names: string[]) => {
  for (const name of names) {
    const value = Bun.env[name]?.trim();
    if (value) return value;
  }

  return undefined;
};

const requireEnv = (description: string, ...names: string[]) => {
  const value = readEnv(...names);
  if (value) return value;

  throw new Error(`Missing ${description}. Set one of: ${names.join(", ")}`);
};

const assertPresent = (name: string, value: string) => {
  if (value.trim()) return value;

  throw new Error(`${name} must not be empty`);
};

const getBackblazeEndpoint = () => {
  const endpoint = readEnv("BACKBLAZE_S3_ENDPOINT", "S3_ENDPOINT", "AWS_ENDPOINT");
  if (endpoint) return endpoint;

  const region = readEnv("BACKBLAZE_S3_REGION");
  if (region) return `https://s3.${region}.backblazeb2.com`;

  throw new Error("Missing Backblaze S3 endpoint. Set BACKBLAZE_S3_ENDPOINT or S3_ENDPOINT.");
};

const getDownloadUrlExpiresIn = (expiresIn = defaultDownloadUrlExpiresIn) => {
  if (Number.isInteger(expiresIn) && expiresIn > 0) return expiresIn;

  throw new Error("expiresIn must be a positive integer number of seconds");
};

export const createPresignedDownloadUrl = ({ bucket, key, expiresIn }: PresignedDownloadUrlInput) =>
  S3Client.presign(assertPresent("key", key), {
    accessKeyId: requireEnv(
      "Backblaze S3 access key ID",
      "BACKBLAZE_S3_ACCESS_KEY_ID",
      "S3_ACCESS_KEY_ID",
      "AWS_ACCESS_KEY_ID",
    ),
    bucket: assertPresent("bucket", bucket),
    endpoint: getBackblazeEndpoint(),
    expiresIn: getDownloadUrlExpiresIn(expiresIn),
    method: "GET",
    region: readEnv("BACKBLAZE_S3_REGION", "S3_REGION", "AWS_REGION"),
    secretAccessKey: requireEnv(
      "Backblaze S3 secret access key",
      "BACKBLAZE_S3_SECRET_ACCESS_KEY",
      "S3_SECRET_ACCESS_KEY",
      "AWS_SECRET_ACCESS_KEY",
    ),
  });
