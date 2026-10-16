import {test, expect} from "bun:test";
import {authorize, validateSeed, selectTracks} from "../src/validation";
import type {Draft, DraftTrack} from "../src/types";

const seed = {mode: "genre", seed: "ambient", count: 15, perArtist: 1, selection: "mix", includeAI: false, country: "AU"};
test("seed requires bounded numbers and explicit AI setting", () => {
  expect(validateSeed(seed).includeAI).toBe(false);
  for (const changes of [{count: 500}, {count: 1.2}, {perArtist: 0}, {includeAI: "false"}, {country: "XX"}, {mode: "url"}, {seed: ""}]) expect(() => validateSeed({...seed, ...changes})).toThrow();
});
test("writes reject foreign host, origin, missing token and non JSON", () => {
  const base = {host: "127.0.0.1:8769", origin: "http://127.0.0.1:8769", "x-wavelength-token": "secret", "content-type": "application/json"};
  const request = (changes = {}) => new Request("http://127.0.0.1:8769/api/jobs", {method: "POST", headers: {...base, ...changes}, body: "{}"});
  expect(() => authorize(request(), 8769, "secret")).not.toThrow();
  for (const changes of [{host: "evil.test:8769"}, {origin: "https://evil.test"}, {origin: "null"}, {"x-wavelength-token": ""}, {"content-type": "text/plain"}]) expect(() => authorize(request(changes), 8769, "secret")).toThrow();
  expect(() => authorize(new Request("http://127.0.0.1:8769/api/session", {headers: {host: "evil.test:8769"}}), 8769, "secret")).toThrow();
});
test("private history reads reject foreign Origin and CSV cannot bypass authorization", () => {
  const headers = {host: "127.0.0.1:8769", "x-wavelength-token": "secret"};
  const read = (changes = {}) => new Request("http://127.0.0.1:8769/api/history?timeZone=UTC", {headers: {...headers, ...changes}});
  expect(() => authorize(read(), 8769, "secret")).not.toThrow();
  for (const changes of [{"x-wavelength-token": ""}, {origin: "null"}, {origin: "https://evil.test"}, {host: "evil.test:8769"}]) expect(() => authorize(read(changes), 8769, "secret")).toThrow();
  const csv = (changes = {}) => new Request("http://127.0.0.1:8769/api/history/preview", {method: "POST", headers: {...headers, origin: "http://127.0.0.1:8769", "content-type": "text/csv", ...changes}, body: "Song Name,Event End Timestamp\nSong,"});
  expect(() => authorize(csv(), 8769, "secret")).not.toThrow();
  for (const changes of [{"x-wavelength-token": ""}, {origin: "https://evil.test"}, {host: "evil.test:8769"}]) expect(() => authorize(csv(changes), 8769, "secret")).toThrow();
});
test("job tracks are server-issued and latest AI exclusions are enforced", () => {
  const tracks: DraftTrack[] = [1, 2].map(id => ({id: String(id), catalogId: id, artistId: id, title: `Song ${id}`, artist: "Artist", album: "Album", durationMs: 120000, releaseDate: "2026-01-01", url: "https://music.apple.com/", source: "test", match: "exact", provenance: {kind: "unknown", evidence: []}, selected: true}));
  const draft = {status: "ready", request: seed, tracks} as Draft;
  expect(selectTracks(draft, ["1"], () => undefined)).toEqual([tracks[0]!]);
  expect(() => selectTracks(draft, ["3"], () => undefined)).toThrow();
  expect(() => selectTracks(draft, ["1", "1"], () => undefined)).toThrow();
  expect(() => selectTracks(draft, ["1"], () => ({kind: "ai", evidence: []}))).toThrow("AI");
  expect(() => selectTracks({...draft, status: "building"}, ["1"], () => undefined)).toThrow();
});
