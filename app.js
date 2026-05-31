/* ===== Vigil — live CT feed simulation ===== */

const DOMAINS = [
{ host: "api.acme.io", ca: "Let's Encrypt", level: "ok" },
{ host: "cdn.acme.io", ca: "Let's Encrypt", level: "ok" },
{ host: "mail.acme.io", ca: "DigiCert", level: "ok" },
{ host: "dashboard.acme.io", ca: "Let's Encrypt", level: "ok" },
{ host: "staging.acme.io", ca: "Let's Encrypt", level: "ok" },
{ host: "vpn-acme.com", ca: "ZeroSSL", level: "warn", flag: "⚠ unrecognized" },
{ host: "acme-login.net", ca: "R3", level: "crit", flag: "✕ policy violation" },
{ host: "secure-acme.co", ca: "Sectigo", level: "warn", flag: "⚠ unrecognized" },
{ host: "git.acme.io", ca: "Let's Encrypt", level: "ok" },
{ host: "api-internal.acme.io", ca: "Let's Encrypt", level: "ok" },
{ host: "grafana.acme.io", ca: "Let's Encrypt", level: "ok" },
{ host: "vault.acme.io", ca: "HashiCorp", level: "ok" },
];

function pad(n) { return n < 10 ? "0" + n : "" + n; }

function nowStamp() {
const d = new Date();
return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
}

function makeLine(entry) {
const div = document.createElement("div");
div.className = "term-line";
const flag = entry.flag
? ` <span class="${entry.level === "crit" ? "crit-flag" : "flag"}">${entry.flag}</span>`
: "";
div.innerHTML =
`<span class="ts">${nowStamp()}</span> ` +
`<span class="${entry.level}">●</span> ` +
`<span class="dom">${entry.host}</span> ` +
`<span class="ca">${entry.ca}</span>${flag}`;
return div;
}

function initFeed(containerId, intervalMs) {
const box = document.getElementById(containerId);
if (!box) return;
let count = box.children.length;
const counter = document.getElementById("entryCount");
function push() {
const entry = DOMAINS[Math.floor(Math.random() * DOMAINS.length)];
const line = makeLine(entry);
box.appendChild(line);
while (box.children.length > 14) box.removeChild(box.firstChild);
box.scrollTop = box.scrollHeight;
count++;
if (counter) counter.textContent = count;
}
for (let i = 0; i < 6; i++) push();
setInterval(push, intervalMs);
}

function init() {
initFeed("heroFeed", 2600);
initFeed("demoFeed", 1500);
}

if (document.readyState === "loading") {
document.addEventListener("DOMContentLoaded", init);
} else {
init();
}
