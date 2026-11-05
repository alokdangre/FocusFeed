// Worker-only Cognito OAuth client. Credentials live in trusted session storage;
// content scripts receive only a short-lived, non-authoritative account summary.
(function (root) {
  "use strict";
  var VAULT = "focusfeedCredentialsV1", MIRROR = "focusfeedAccountV1";
  function localEndpoint(endpoint) {
    var url = new URL(endpoint);
    return url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname);
  }
  function failure(code, message) { var error = new Error(message); error.code = code; return error; }
  function create(options) {
    var api = options.api || chrome, transport = options.fetch || fetch, configs = new Map();
    var generation = 0, login = null, refresh = null, checking = null, last = null;
    var vault = api.storage.session;
    var ready = vault && vault.setAccessLevel ? vault.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }) : Promise.resolve();
    async function json(url, init) {
      var controller = new AbortController(), timer = setTimeout(function () { controller.abort(); }, 8000);
      try {
        var response = await transport(url, Object.assign({}, init, { credentials: "omit", cache: "no-store", signal: controller.signal }));
        var body = await response.json().catch(function () { return {}; });
        if (!response.ok) throw failure(body.error && body.error.code || "account_unavailable",
          body.error && body.error.message || "Could not check your OwnFeed account.");
        return body;
      } finally { clearTimeout(timer); }
    }
    async function config(endpoint) {
      var cached = configs.get(endpoint);
      if (cached && cached.until > Date.now()) return cached.value;
      var health = await options.health(endpoint), value = health.auth;
      // Compatibility is limited to old loopback development servers. A hosted
      // server which omits authentication metadata is never treated as free AI.
      if (!value && localEndpoint(endpoint)) value = { mode: "local" };
      if (!value || !["local", "required"].includes(value.mode) || value.configured === false) {
        throw failure("auth_unavailable", "Account sign-in is temporarily unavailable.");
      }
      if (value.mode === "local") {
        if (!localEndpoint(endpoint)) throw failure("auth_unavailable", "Hosted AI requires account authentication.");
      } else if (!/^https:\/\/cognito-idp\.[a-z0-9-]+\.amazonaws\.com(?:\.cn)?\/[A-Za-z0-9_-]+$/.test(value.issuer) ||
          !/^https:\/\/[a-z0-9.-]+\.auth\.[a-z0-9-]+\.amazoncognito\.com(?:\.cn)?$/.test(value.domain) ||
          !/^[a-z0-9]{10,128}$/.test(value.clientId) || value.scope !== "openid email focusfeed/ai") {
        throw failure("auth_unavailable", "Account sign-in is temporarily unavailable.");
      }
      configs.set(endpoint, { value: value, until: Date.now() + 300000 }); return value;
    }
    async function credentials(endpoint, configuration) {
      await ready;
      if (!vault) throw failure("auth_unavailable", "Update Chrome to sign in to OwnFeed.");
      var record = (await vault.get(VAULT))[VAULT];
      return record && record.endpoint === endpoint && record.issuer === configuration.issuer &&
        record.clientId === configuration.clientId && record.domain === configuration.domain ? record : null;
    }
    async function publish(value, expected) {
      if (expected !== undefined && expected !== generation) throw failure("account_changed", "Your account changed. Try again.");
      var previous = (await api.storage.local.get(MIRROR))[MIRROR];
      if (options.onBoundary && (value.signedOut || previous && (previous.endpoint !== value.endpoint || previous.userId !== value.userId || previous.premium && !value.premium) ||
          !previous && value.mode === "required" && value.userId)) await options.onBoundary();
      if (expected !== undefined && expected !== generation) throw failure("account_changed", "Your account changed. Try again.");
      last = Object.assign({}, value, { checkedAt: Date.now() });
      last.validUntil = last.premium && last.mode !== "local" ? Math.min(Date.now() + 60000, Number(last.accessUntil) * 1000) : 0;
      await api.storage.local.set({ [MIRROR]: last }); return last;
    }
    async function saveTokens(endpoint, configuration, body, previous, expected) {
      if (expected !== generation) throw failure("account_changed", "Your account changed. Try again.");
      if (typeof body.access_token !== "string" || body.access_token.length > 8192 || body.token_type !== "Bearer" ||
          !Number.isFinite(body.expires_in) || body.expires_in <= 0 || body.expires_in > 86400) {
        throw failure("invalid_session", "Sign-in returned an invalid session. Try again.");
      }
      var record = { endpoint: endpoint, issuer: configuration.issuer, clientId: configuration.clientId, domain: configuration.domain,
        accessToken: body.access_token, refreshToken: body.refresh_token || previous && previous.refreshToken,
        expiresAt: Date.now() + body.expires_in * 1000 };
      if (typeof record.refreshToken !== "string" || record.refreshToken.length > 8192) throw failure("invalid_session", "Sign in again to continue.");
      await vault.set({ [VAULT]: record });
      if (expected !== generation) { await vault.remove(VAULT); throw failure("account_changed", "Your account changed. Try again."); }
      return record;
    }
    async function headers(endpoint) {
      var configuration = await config(endpoint);
      if (configuration.mode === "local") return {};
      var record = await credentials(endpoint, configuration), expected = generation;
      if (!record) throw failure("authentication_required", "Sign in to use AI filtering. Layout controls work without an account.");
      if (record.expiresAt <= Date.now() + 30000) {
        if (!refresh) {
          refresh = (async function () {
            var body = await json(configuration.domain + "/oauth2/token", { method: "POST",
              headers: { "content-type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({ grant_type: "refresh_token", client_id: configuration.clientId, refresh_token: record.refreshToken }).toString() });
            return saveTokens(endpoint, configuration, body, record, expected);
          })().finally(function () { refresh = null; });
        }
        try { record = await refresh; }
        catch (error) { if (expected === generation) await denied(endpoint, error, "Bearer " + record.accessToken); throw error; }
      }
      if (expected !== generation) throw failure("account_changed", "Your account changed. Try again.");
      return { Authorization: "Bearer " + record.accessToken };
    }
    async function status(force) {
      var endpoint = await options.endpoint();
      if (!force && last && last.endpoint === endpoint && Date.now() - last.checkedAt < 45000) return last;
      if (checking) return checking;
      var expected = generation;
      checking = (async function () {
        try {
          var configuration = await config(endpoint);
          if (configuration.mode === "local") return await publish({ endpoint: endpoint, mode: "local", userId: "local-developer", premium: true, accessUntil: null }, expected);
          if (!await credentials(endpoint, configuration)) return await publish({ endpoint: endpoint, mode: "required", userId: null, premium: false, accessUntil: null }, expected);
          var value = await json(endpoint + "/account", { method: "GET", headers: await headers(endpoint) });
          if (!value || value.mode !== "required" || !/^[A-Za-z0-9_-]{1,128}$/.test(value.userId) || typeof value.premium !== "boolean" ||
              value.premium && (!Number.isFinite(value.accessUntil) || value.accessUntil * 1000 <= Date.now())) {
            throw failure("account_unavailable", "Could not verify your AI access. Try again.");
          }
          return await publish({ endpoint: endpoint, mode: "required", userId: value.userId, premium: value.premium, accessUntil: value.accessUntil }, expected);
        } catch (error) {
          if (expected !== generation) throw error;
          if (["invalid_session", "authentication_required"].includes(error.code) && vault) await vault.remove(VAULT);
          await publish({ endpoint: endpoint, mode: "required", userId: null, premium: false, accessUntil: null, error: error.code || "account_unavailable" }, expected);
          throw error;
        }
      })().finally(function () { checking = null; });
      return checking;
    }
    async function premium() {
      var value = await status(true);
      if (!value.premium) throw failure(value.userId ? "subscription_required" : "authentication_required",
        value.userId ? "Your account does not have active Pro access. Layout controls are available." : "Sign in to use AI filtering. Layout controls are available.");
      return value;
    }
    function encode(bytes) { return btoa(String.fromCharCode.apply(null, bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
    async function testLocal(endpoint) {
      if (!localEndpoint(endpoint)) throw failure("local_testing_unavailable", "Testing without sign-in requires a localhost server.");
      configs.delete(endpoint);
      var configuration = await config(endpoint);
      if (configuration.mode !== "local") throw failure("local_testing_unavailable", "Start the test server with: bash backend/run_local.sh --local, then try again.");
      ++generation; last = null; checking = null;
      await options.selectEndpoint(endpoint);
      return status(true);
    }
    async function signIn() {
      if (login) return login;
      var expected = ++generation;
      login = (async function () {
        var endpoint = await options.endpoint(), configuration = await config(endpoint);
        if (configuration.mode === "local") return status(true);
        await ready;
        if (!vault || !api.identity) throw failure("auth_unavailable", "Update Chrome to sign in to OwnFeed.");
        var verifier = encode(crypto.getRandomValues(new Uint8Array(32))), state = encode(crypto.getRandomValues(new Uint8Array(32)));
        var challenge = encode(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
        var redirect = api.identity.getRedirectURL("callback"), url = new URL(configuration.domain + "/oauth2/authorize");
        url.search = new URLSearchParams({ client_id: configuration.clientId, response_type: "code", redirect_uri: redirect,
          scope: configuration.scope, state: state, code_challenge: challenge, code_challenge_method: "S256" }).toString();
        var returned = new URL(await api.identity.launchWebAuthFlow({ url: url.href, interactive: true }));
        if (expected !== generation || returned.origin + returned.pathname !== redirect || returned.searchParams.get("state") !== state ||
            returned.searchParams.has("error") || !returned.searchParams.get("code")) throw failure("invalid_session", "Sign-in was cancelled or could not be verified.");
        var body = await json(configuration.domain + "/oauth2/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ grant_type: "authorization_code", client_id: configuration.clientId, redirect_uri: redirect,
            code: returned.searchParams.get("code"), code_verifier: verifier }).toString() });
        await saveTokens(endpoint, configuration, body, null, expected);
        checking = null; last = null; return status(true);
      })().finally(function () { login = null; });
      return login;
    }
    async function signOut() {
      ++generation; last = null; configs.clear();
      await ready;
      var record = vault && (await vault.get(VAULT))[VAULT];
      if (vault) await vault.remove(VAULT);
      var endpoint = await options.endpoint();
      var value = await publish({ endpoint: endpoint, mode: "required", userId: null, premium: false, accessUntil: null, signedOut: true });
      // Revoke this specific server session as well as the refresh token. Local
      // sign-out completes even offline; report when server confirmation failed.
      if (record && record.endpoint === endpoint) {
        try { await json(endpoint + "/account/logout", { method: "POST", headers: { Authorization: "Bearer " + record.accessToken } }); }
        catch (_) { value.remoteSignOutPending = true; }
      }
      if (record && record.refreshToken) await json(record.domain + "/oauth2/revoke", { method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: record.clientId, token: record.refreshToken }).toString() }).catch(function () {});
      return value;
    }
    async function denied(endpoint, error, authorization) {
      if (!error || !["invalid_session", "authentication_required", "subscription_required"].includes(error.code)) return;
      if (authorization && vault) {
        var current = (await vault.get(VAULT))[VAULT];
        // A late response for a previous login must not revoke the new login.
        if (!current || current.endpoint !== endpoint || "Bearer " + current.accessToken !== authorization) return;
      }
      if (error.code !== "subscription_required") { ++generation; if (vault) await vault.remove(VAULT); }
      return publish({ endpoint: endpoint, mode: "required", userId: error.code === "subscription_required" && last && last.userId || null,
        premium: false, accessUntil: null, error: error.code });
    }
    return { status: status, premium: premium, headers: headers, signIn: signIn, signOut: signOut, denied: denied, testLocal: testLocal };
  }
  root.FocusFeedAccountClient = { create: create, localEndpoint: localEndpoint };
})(globalThis);
