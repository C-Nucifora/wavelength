import {readFile} from "node:fs/promises";
import {runInNewContext} from "node:vm";
import {strict as assert} from "node:assert";
const source = await readFile(new URL("WrapperCapture.swift", import.meta.url), "utf8");
const script = source.match(/static let observer = #"""\n([\s\S]*?)\n\s*"""#/)![1];
let messages: any[] = [];
let calls: any[] = [];
const response = Promise.resolve("original-response");
class XHR {
  open(...args: any[]) { calls.push(["open", this, args]); return "opened"; }
  setRequestHeader(...args: any[]) { calls.push(["header", this, args]); return "set"; }
  send(...args: any[]) { calls.push(["send", this, args]); return "sent"; }
}
const originalFetch = function(this: any, ...args: any[]) { calls.push(["fetch", this, args]); return response; };
const window: any = {location: {protocol: "https:", hostname: "music.apple.com", port: "", href: "https://music.apple.com/au"}, fetch: originalFetch, XMLHttpRequest: XHR, webkit: {messageHandlers: {wavelengthCapture: {postMessage: (x: any) => messages.push(x)}}}};
window.top = window;
runInNewContext(script, {window, URL, Headers, Request, WeakMap, Object});
const target = "https://amp-api.music.apple.com/v1/me/storefront";
const headers = {Authorization: "Bearer fixture-bearer", "Media-User-Token": "fixture-user"};
assert.equal(window.fetch(target, {headers}), response, "Fetch promise preserved");
assert.equal(messages.length, 0, "Observer dormant before native fallback");
assert.equal(typeof window.__wavelengthCapture?.start, "function", "Native fallback enablement exists");
window.__wavelengthCapture.start("fixture-generation");
const request = new Request(target, {headers: {...headers, "Media-User-Token": "request-user"}});
assert.equal(window.fetch(request, {headers}), response);
assert.deepEqual(JSON.parse(JSON.stringify(messages.pop())), {bearer: "Bearer fixture-bearer", user: "fixture-user", generation: "fixture-generation"}, "Init headers override Request headers");
assert.equal(calls.at(-1)?.[1], window, "Fetch receiver preserved");
assert.equal(calls.at(-1)?.[2][0], request, "Fetch Request passed through without cloning its body");
window.fetch(request);
assert.equal(messages.pop()?.user, "request-user", "Native Request headers captured without init overrides");
for (const url of ["https://amp-api.music.apple.com.evil.test", "http://amp-api.music.apple.com", "https://idmsa.apple.com", "https://amp-api.music.apple.com:444", "https://user@amp-api.music.apple.com"]) window.fetch(url, {headers});
assert.equal(messages.length, 0, "Exact trusted HTTPS destination only");
window.fetch(target, {headers: {Authorization: "fixture"}});
assert.equal(messages.length, 0, "Partial headers never bridged");
const xhr = new XHR();
assert.equal(xhr.open("GET", target), "opened");
assert.equal(xhr.setRequestHeader("Authorization", headers.Authorization), "set");
xhr.setRequestHeader("Media-User-Token", headers["Media-User-Token"]);
assert.equal(xhr.send("untouched-body"), "sent");
assert.equal(messages.pop()?.user, "fixture-user", "XHR complete headers captured");
xhr.open("GET", target); xhr.send();
assert.equal(messages.length, 0, "XHR open resets previous headers");
window.__wavelengthCapture.stop();
assert.equal(window.fetch, originalFetch, "Teardown restores fetch");
assert.equal(calls.find(x => x[0] === "send")?.[2][0], "untouched-body", "XHR body passed unchanged");
const foreign: any = {...window, location: {...window.location, hostname: "idmsa.apple.com"}, fetch: originalFetch};
delete foreign.__wavelengthCapture; foreign.top = foreign;
runInNewContext(script, {window: foreign, URL, Headers, Request, WeakMap, Object});
assert.equal(foreign.fetch, originalFetch, "Login page never instrumented");
const subframe: any = {...window, fetch: originalFetch}; subframe.top = window; delete subframe.__wavelengthCapture;
runInNewContext(script, {window: subframe, URL, Headers, Request, WeakMap, Object});
assert.equal(subframe.fetch, originalFetch, "Subframe never instrumented");
const failure = new Error("fixture-error");
class ThrowingXHR {
  open() { return "opened"; }
  setRequestHeader() { throw failure; }
  send() { throw failure; }
}
const throwing: any = {...window, fetch: () => { throw failure; }, XMLHttpRequest: ThrowingXHR};
throwing.top = throwing; delete throwing.__wavelengthCapture;
runInNewContext(script, {window: throwing, URL, Headers, Request, WeakMap, Object});
throwing.__wavelengthCapture.start("fixture-generation");
assert.throws(() => throwing.fetch(target, {headers}), error => error === failure, "Fetch exception preserved");
const failedXHR = new ThrowingXHR(); failedXHR.open();
assert.throws(() => failedXHR.setRequestHeader(), error => error === failure, "XHR header exception preserved");
assert.throws(() => failedXHR.send(), error => error === failure, "XHR send exception preserved");

// The real Request constructor exercises WebIDL conversion at the fetch boundary.
// These catch consumption or repeated user getter/coercion before native conversion.
function conversionFixture() {
  const observed: Request[] = [], captured: any[] = [];
  class ConvertingXHR {
    open(_method: any, url: any) { String(url); return "opened"; }
    setRequestHeader(name: any, value: any) { String(name); String(value); return "set"; }
    send() { return "sent"; }
  }
  const fixture: any = {
    location: {...window.location}, XMLHttpRequest: ConvertingXHR,
    fetch(input: any, init: any) { observed.push(new Request(input, init)); return response; },
    webkit: {messageHandlers: {wavelengthCapture: {postMessage: (value: any) => captured.push(value)}}},
  };
  fixture.top = fixture;
  runInNewContext(script, {window: fixture, URL, Headers, Request, WeakMap, Object});
  fixture.__wavelengthCapture.start("fixture-generation");
  return {fixture, observed, captured, ConvertingXHR};
}
if (!process.argv[2] || process.argv[2] === "iterable") {
  const {fixture, observed, captured} = conversionFixture();
  const iterable = (function* () { yield ["Authorization", "Bearer iterable-bearer"]; yield ["Media-User-Token", "iterable-user"]; })();
  assert.equal(fixture.fetch(target, {headers: iterable}), response);
  assert.equal(observed[0].headers.get("authorization"), "Bearer iterable-bearer", "One-shot HeadersInit reaches original fetch unconsumed");
  assert.equal(observed[0].headers.get("media-user-token"), "iterable-user");
  assert.equal(captured.length, 0, "Iterable headers skipped instead of consumed for observation");
}
if (!process.argv[2] || process.argv[2] === "getter") {
  const {fixture, observed, captured} = conversionFixture();
  let reads = 0;
  fixture.fetch(target, {get headers() { reads++; return {Authorization: `Bearer getter-${reads}`, "Media-User-Token": `getter-${reads}`}; }});
  assert.equal(reads, 1, "Headers getter read only by original fetch");
  assert.equal(observed[0].headers.get("authorization"), "Bearer getter-1");
  assert.equal(captured.length, 0, "Accessor-backed init headers skipped");
}
if (!process.argv[2] || process.argv[2] === "record") {
  const {fixture, observed, captured} = conversionFixture();
  let reads = 0;
  fixture.fetch(target, {headers: {get Authorization() { reads++; return `Bearer nested-${reads}`; }, "Media-User-Token": "nested-user"}});
  assert.equal(reads, 1, "Record header getter read only by original fetch");
  assert.equal(observed[0].headers.get("authorization"), "Bearer nested-1");
  assert.equal(captured.length, 0, "Accessor-backed header record skipped");
}
if (!process.argv[2] || process.argv[2] === "passive") {
  const {fixture, observed, captured} = conversionFixture();
  const request = new Request(target, {headers});
  assert.equal(fixture.fetch(request), response);
  assert.equal(observed[0].headers.get("authorization"), "Bearer fixture-bearer");
  assert.equal(captured.pop()?.bearer, "Bearer fixture-bearer", "Passive native Request still observed after original conversion");
  fixture.fetch(target, {headers});
  assert.equal(observed[1].headers.get("media-user-token"), "fixture-user");
  assert.equal(captured.pop()?.user, "fixture-user", "Passive string record still observed after original conversion");
}
if (!process.argv[2] || process.argv[2] === "xhr") {
  const {fixture, ConvertingXHR, captured} = conversionFixture();
  const xhr = new ConvertingXHR();
  let urlCoercions = 0, nameCoercions = 0, valueCoercions = 0;
  xhr.open("GET", {toString() { urlCoercions++; return target; }});
  xhr.setRequestHeader({toString() { nameCoercions++; return "Authorization"; }}, {toString() { valueCoercions++; return "Bearer coerced"; }});
  xhr.setRequestHeader("Media-User-Token", "coerced-user"); xhr.send();
  assert.deepEqual([urlCoercions, nameCoercions, valueCoercions], [1, 1, 1], "XHR observer does not repeat caller string coercions");
  assert.equal(captured.length, 0, "XHR arguments needing coercion skipped");
  assert.equal(typeof fixture.__wavelengthCapture.stop, "function");
}
console.log("PASS: dormant capture, exact hosts, Request overrides, XHR and teardown");
