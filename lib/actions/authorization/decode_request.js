const { pick } = require('lodash');

const JWT = require('../../helpers/jwt');
const instance = require('../../helpers/weak_cache');
const { InvalidRequestObject } = require('../../helpers/errors');

/*
 * Decrypts and validates the content of provided request parameter and replaces the parameters
 * provided via OAuth2.0 authorization request with these
 *
 * @throws: invalid_request_object
 */
module.exports = (provider, whitelist) => {
  const PARAM_LIST = Array.from(whitelist);
  const { keystore, configuration: conf } = instance(provider);

  return async function decodeRequest(ctx, next) {
    const { params, client } = ctx.oidc;
    let wasSignedOrEncrypted = false; // signed or encrypted by client confidential material

    if (params.request === undefined) {
      await next();
      return;
    }

    if (conf('features.encryption') && params.request.split('.').length === 5) {
      try {
        const header = JWT.header(params.request);

        if (!conf('requestObjectEncryptionAlgValues').includes(header.alg)) {
          throw new Error('unsupported encrypted request alg');
        }
        if (!conf('requestObjectEncryptionEncValues').includes(header.enc)) {
          throw new Error('unsupported encrypted request enc');
        }

        let decrypted;
        if (header.alg.match(/^(A|P)/)) {
          decrypted = await JWT.decrypt(params.request, client.keystore);
          wasSignedOrEncrypted = true;
        } else {
          decrypted = await JWT.decrypt(params.request, keystore);
        }

        params.request = decrypted.payload.toString('utf8');
      } catch (err) {
        throw new InvalidRequestObject(`could not decrypt request object (${err.message})`);
      }
    }

    let decoded;

    try {
      decoded = JWT.decode(params.request);
    } catch (err) {
      throw new InvalidRequestObject(`could not parse request object as valid JWT (${err.message})`);
    }

    const { payload, header: { alg } } = decoded;

    if (payload.request !== undefined || payload.request_uri !== undefined) {
      throw new InvalidRequestObject('request object must not contain request or request_uri properties');
    }

    if (payload.response_type !== undefined && payload.response_type !== params.response_type) {
      throw new InvalidRequestObject('request response_type must equal the one in request parameters');
    }

    if (payload.client_id !== undefined && payload.client_id !== params.client_id) {
      throw new InvalidRequestObject('request client_id must equal the one in request parameters');
    }

    if (client.requestObjectSigningAlg && client.requestObjectSigningAlg !== alg) {
      throw new InvalidRequestObject('the preregistered alg must be used in request or request_uri');
    }

    if (!conf('requestObjectSigningAlgValues').includes(alg)) {
      throw new InvalidRequestObject('unsupported signed request alg');
    }

    if (alg !== 'none') {
      try {
        const opts = {
          issuer: payload.iss ? client.clientId : undefined,
          audience: payload.aud ? provider.issuer : undefined,
          clockTolerance: conf('clockTolerance'),
        };
        await JWT.verify(params.request, client.keystore, opts);
        wasSignedOrEncrypted = true;
      } catch (err) {
        throw new InvalidRequestObject(`could not validate request object (${err.message})`);
      }
    }

    const request = pick(payload, PARAM_LIST);

    if (request.claims && typeof request.claims !== 'string') {
      request.claims = JSON.stringify(request.claims);
    }

    if (wasSignedOrEncrypted) ctx.oidc.signed = Object.keys(request);
    Object.assign(params, request);

    params.request = undefined;

    await next();
  };
};
