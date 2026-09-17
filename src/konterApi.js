"use strict";

const { BASE_URL, COOKIE } = require("./config");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";

let cookieJar = COOKIE || "";

function _setCookiesFromHeaders(headers) {
  if (!headers) return;
  let setCookies = headers.getSetCookie ? headers.getSetCookie() : [];
  if (!setCookies.length && headers.get && headers.get("set-cookie")) {
    setCookies = splitSetCookie(headers.get("set-cookie"));
  }
  for (const sc of setCookies) {
    const semi = sc.indexOf(";");
    const pair = (semi === -1 ? sc : sc.slice(0, semi)).trim();
    if (!pair) continue;
    const name = pair.split("=")[0];
    replaceCookie(name, pair);
  }
}

function splitSetCookie(value) {
  // naive split; set-cookie biasanya single string bila tidak pakai getSetCookie
  return value ? [value] : [];
}

function replaceCookie(name, pair) {
  const re = new RegExp("(^|;\\s*)" + escapeRegExp(name) + "=[^;]*(;|$)", "g");
  if (re.test(cookieJar)) {
    cookieJar = cookieJar.replace(re, "$1" + pair + "$2");
  } else {
    cookieJar = (cookieJar ? cookieJar + "; " : "") + pair;
  }
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function request(method, urlPath, { body, form } = {}) {
  const url = /^https?:\/\//.test(urlPath) ? urlPath : BASE_URL + urlPath;
  const headers = {
    "User-Agent": UA,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    Cookie: cookieJar,
  };

  let payload;
  if (body) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  } else if (form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8";
    payload = new URLSearchParams(form).toString();
  }

  const res = await fetch(url, { method, headers, body: payload, redirect: "manual" });
  _setCookiesFromHeaders(res.headers);

  return res;
}

async function getBuffer(urlPath) {
  const res = await request("GET", urlPath);
  let buf = null;
  try {
    buf = Buffer.from(await res.arrayBuffer());
  } catch (e) {
    buf = null;
  }
  return { status: res.status, buffer: buf, contentType: res.headers.get("content-type") };
}

async function getHTML(urlPath) {
  const r = await request("GET", urlPath);
  let text = "";
  try {
    text = await r.text();
  } catch (e) {
    text = "";
  }
  return { status: r.status, headers: r.headers, text };
}

async function getJSON(urlPath) {
  const r = await request("GET", urlPath);
  let text = "";
  try {
    text = await r.text();
  } catch (e) {
    text = "";
  }
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch (e) {
      json = null;
    }
  }
  return { status: r.status, json, text };
}

module.exports = { request, getHTML, getBuffer, getJSON, cookieJar: () => cookieJar };
