import { HttpError } from './errors.js';
import type { JsonObject } from './model.js';

export function allowOnly(payload: JsonObject, keys: string[]) {
  const extra = Object.keys(payload).find((key) => !keys.includes(key));
  if (extra) throw new HttpError(422, `unexpected field: ${extra}`);
}

export function requiredString(payload: JsonObject, key: string) {
  const value = payload[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new HttpError(422, `${key} is required`);
  }
  return value;
}

export function optionalString(payload: JsonObject, key: string) {
  const value = payload[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new HttpError(422, `${key} must be a string or null`);
  return value;
}

export function stringArray(payload: JsonObject, key: string) {
  const value = payload[key] ?? [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new HttpError(422, `${key} must be an array of strings`);
  }
  return value as string[];
}
