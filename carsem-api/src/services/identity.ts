/**
 * Identity: DIDs and verifiable credentials.
 *
 * Masumi's identity layers (per the Masumi docs): an on-chain registry NFT for
 * each agent, plus W3C DIDs and Verifiable Credentials referenced from it.
 * Masumi does not issue DIDs/VCs itself yet, so CARSEM does, with standard
 * methods any W3C resolver understands:
 *   platform  did:web:<host>                     (the credential issuer)
 *   user      did:web:<host>:users:<id>          (subject of the KYC credential)
 *   agent     did:masumi:agent:<agentIdentifier> once registered on the Masumi registry,
 *             did:web:<host>:agents:<id> before that
 * Credentials are VC 2.0 secured as JWT (EdDSA / Ed25519).
 */
import { createPrivateKey, createPublicKey, randomUUID, sign, verify, type KeyObject } from "node:crypto";
import type { Config } from "../config.js";
import { HttpError } from "./errors.js";

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const b64url = (data: Buffer | string) => Buffer.from(data).toString("base64url");

export interface KycCredentialInput {
  userId: string; userDid: string; agentDid: string; walletAddress: string; provider: string; level: string; verifiedAt: number;
  /** The user's own wallet (Lace), proven with CIP-30 signData. */
  ownerWallet: { id: string; address: string | null; provenAt: number };
}

/** The user's own Cardano wallet, as it appears in their DID document. */
export interface OwnerWallet { id: string; publicKey: string | null }

export class Issuer {
  private readonly key: KeyObject;
  readonly publicJwk: { kty: string; crv: string; x: string };
  readonly did: string;

  constructor(private readonly config: Config) {
    this.key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, config.issuerSeed]), format: "der", type: "pkcs8" });
    const jwk = createPublicKey(this.key).export({ format: "jwk" }) as { kty: string; crv: string; x: string };
    this.publicJwk = { kty: jwk.kty, crv: jwk.crv, x: jwk.x };
    // did:web encodes the port's colon as %3A.
    this.did = `did:web:${new URL(config.publicUrl).host.replace(":", "%3A")}`;
  }

  get keyId() { return `${this.did}#key-1`; }
  userDid(userId: string) { return `${this.did}:users:${userId}`; }
  agentDid(agentId: string, masumiAgentId?: string | null) {
    return masumiAgentId ? `did:masumi:agent:${masumiAgentId}` : `${this.did}:agents:${agentId}`;
  }

  didDocument() {
    return {
      "@context": ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/suites/jws-2020/v1"],
      id: this.did,
      verificationMethod: [{ id: this.keyId, type: "JsonWebKey2020", controller: this.did, publicKeyJwk: this.publicJwk }],
      assertionMethod: [this.keyId],
      service: [{ id: `${this.did}#carsem`, type: "CarsemPlatform", serviceEndpoint: this.config.publicUrl }],
    };
  }

  /** A user's DID document. Keys are custodial (CARSEM controls them), so the platform is the controller. */
  userDidDocument(userId: string, agentDid?: string, wallet?: OwnerWallet) {
    const id = this.userDid(userId);
    // The key in the user's own wallet authenticates as this DID (it signed in with CIP-8).
    const walletKey = wallet?.publicKey ? [{
      id: `${id}#wallet`, type: "JsonWebKey", controller: id,
      publicKeyJwk: { kty: "OKP", crv: "Ed25519", x: Buffer.from(wallet.publicKey, "hex").toString("base64url") },
    }] : [];
    return {
      "@context": ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/jwk/v1"],
      id,
      controller: this.did,
      ...(wallet ? { alsoKnownAs: [`cardano:preprod:${wallet.id}`] } : {}),
      ...(walletKey.length ? { verificationMethod: walletKey, authentication: [walletKey[0].id] } : {}),
      service: [
        ...(agentDid ? [{ id: `${id}#agent`, type: "MasumiAgent", serviceEndpoint: agentDid }] : []),
        { id: `${id}#credentials`, type: "LinkedVerifiablePresentation", serviceEndpoint: `${this.config.publicUrl}/credentials/status/${userId}` },
      ],
    };
  }

  /** Signs a W3C VC 2.0 "KYC verified" credential as a JWT. */
  issueKycCredential(input: KycCredentialInput) {
    const now = Date.now();
    const credential = {
      "@context": ["https://www.w3.org/ns/credentials/v2"],
      id: `urn:uuid:${randomUUID()}`,
      type: ["VerifiableCredential", "KycVerifiedCredential"],
      issuer: this.did,
      validFrom: new Date(now).toISOString(),
      validUntil: new Date(now + 365 * 24 * 3600_000).toISOString(),
      credentialSubject: {
        id: input.userDid,
        kyc: { status: "verified", provider: input.provider, level: input.level, verifiedAt: new Date(input.verifiedAt).toISOString() },
        agent: { id: input.agentDid, wallet: input.walletAddress, onePlatformWallet: true },
        cardanoWallet: {
          id: input.ownerWallet.id, payoutAddress: input.ownerWallet.address, network: "cardano:preprod",
          proof: "CIP-30 signData (CIP-8 COSE_Sign1)", provenAt: new Date(input.ownerWallet.provenAt).toISOString(),
        },
      },
      credentialStatus: { id: `${this.config.publicUrl}/credentials/status/${input.userId}`, type: "CarsemRevocationStatus" },
    };
    const header = { alg: "EdDSA", typ: "vc+jwt", kid: this.keyId };
    const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(credential))}`;
    return { jwt: `${signingInput}.${b64url(sign(null, Buffer.from(signingInput), this.key))}`, credential };
  }

  /** Verifies a credential JWT signed by this issuer. Returns the credential. */
  verifyJwt(jwt: string) {
    const parts = jwt.split(".");
    if (parts.length !== 3) throw new HttpError(400, "Not a JWT");
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString()) as { alg?: string; kid?: string };
    if (header.alg !== "EdDSA" || header.kid !== this.keyId) throw new HttpError(400, "Credential was not issued by this CARSEM issuer");
    const ok = verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey(this.key), Buffer.from(parts[2], "base64url"));
    if (!ok) throw new HttpError(400, "Invalid credential signature");
    const credential = JSON.parse(Buffer.from(parts[1], "base64url").toString()) as { validUntil?: string; credentialSubject: { id: string } };
    if (credential.validUntil && Date.parse(credential.validUntil) < Date.now()) throw new HttpError(400, "Credential expired");
    return credential;
  }
}
