// Casdoor OIDC (auth.trance-0.com). Authorization-code flow via openid-client,
// then a group-claim gate. The required group mirrors Gitea's Casdoor setup but
// renamed from `trance-0/app-gitea` to `trance-0/app-agent`.

import { Issuer, generators } from "openid-client";
import { config } from "./config.js";

let client;

export async function initOidc() {
  const issuer = await Issuer.discover(config.oidc.issuer);
  client = new issuer.Client({
    client_id: config.oidc.clientId,
    client_secret: config.oidc.clientSecret,
    redirect_uris: [config.oidc.redirectUri],
    response_types: ["code"],
  });
  return client;
}

export function oidcReady() {
  return Boolean(client);
}

export function loginUrl(req) {
  const state = generators.state();
  const nonce = generators.nonce();
  req.session.oidc = { state, nonce };
  return client.authorizationUrl({
    scope: "openid profile email groups",
    state,
    nonce,
  });
}

export async function handleCallback(req) {
  const params = client.callbackParams(req);
  const tokenSet = await client.callback(config.oidc.redirectUri, params, {
    state: req.session?.oidc?.state,
    nonce: req.session?.oidc?.nonce,
  });
  delete req.session?.oidc;
  const userinfo = await client.userinfo(tokenSet.access_token);
  return { userinfo, tokenSet };
}

// Return the groups claim as an array regardless of Casdoor's shape.
export function groupsOf(userinfo) {
  const g = userinfo?.groups ?? userinfo?.Groups ?? userinfo?.group ?? [];
  if (Array.isArray(g)) return g.map(String);
  if (typeof g === "string") return g.split(/[\s,]+/).filter(Boolean);
  return [];
}

export function isAuthorized(userinfo) {
  return groupsOf(userinfo).includes(config.oidc.requiredGroup);
}
