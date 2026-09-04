import {
  DEFAULT_TOLERANCE_SECONDS,
  computeSignature,
  parseSignatureHeader,
  verifyStripeSignature,
} from '../stripe/stripe-signature';

/**
 * La vérification de signature — la seule chose qui distingue Stripe de
 * n'importe qui sur une route publique et non gardée.
 *
 * Les cas exigés par payments-stripe §7 (« tester au minimum : […] signature
 * invalide ») y sont, et quelques-uns de plus : ce sont ceux qu'une
 * réimplémentation du schéma peut rater sans que rien ne le dise.
 */

/**
 * Un secret de terminaison factice, délibérément **pauvre en entropie** et
 * portant « not_a_secret » dans son texte.
 *
 * Ce n'est pas de la coquetterie : gitleaks scanne le dépôt à chaque PR, et sa
 * règle `generic-api-key` retient toute chaîne d'entropie suffisante affectée à
 * un identifiant nommé `SECRET`. Une valeur d'allure aléatoire ferait rougir la
 * barrière « Fuite de secrets » sans qu'aucun secret n'ait fuité — et le
 * réflexe qui s'installerait alors serait d'ignorer ce check.
 *
 * La même valeur, au numéro près, sert dans `test/setup-env.ts` et dans le
 * harnais de recette. Ce que les tests exercent ne dépend pas d'elle : la
 * signature est recalculée à chaque cas.
 */
const SECRET = 'whsec_test_not_a_secret_0004';
const PAYLOAD = Buffer.from('{"id":"evt_1","type":"payment_intent.succeeded"}', 'utf8');
const TIMESTAMP = 1_772_000_000;
const NOW = TIMESTAMP * 1000;

function header(parts: readonly string[]): string {
  return parts.join(',');
}

function validHeader(timestamp = TIMESTAMP, payload = PAYLOAD): string {
  return header([`t=${timestamp}`, `v1=${computeSignature(SECRET, timestamp, payload)}`]);
}

describe('parseSignatureHeader', () => {
  it('lit l’horodatage et toutes les signatures v1', () => {
    const parsed = parseSignatureHeader('t=1492774577,v1=aaa,v1=bbb');

    expect(parsed).toEqual({ timestamp: 1_492_774_577, signatures: ['aaa', 'bbb'] });
  });

  it('ignore les schémas qu’il ne connaît pas', () => {
    // `v0` accompagne les signatures de Stripe CLI ; il n'est pas le nôtre, et
    // sa présence ne doit ni gêner ni être prise pour une signature.
    const parsed = parseSignatureHeader('t=1,v0=zzz,v1=aaa');

    expect(parsed).toEqual({ timestamp: 1, signatures: ['aaa'] });
  });

  it('tolère les espaces autour des séparateurs', () => {
    expect(parseSignatureHeader('t=1, v1=aaa')).toEqual({ timestamp: 1, signatures: ['aaa'] });
  });

  it('refuse un horodatage qui n’est pas entier de bout en bout', () => {
    // `Number.parseInt` aurait lu 12 dans « 12abc » : l'en-tête est produit par
    // une machine, une valeur approximative y est un signe de falsification.
    expect(parseSignatureHeader('t=12abc,v1=aaa')).toBeNull();
  });

  it('refuse un en-tête sans horodatage ou sans signature v1', () => {
    expect(parseSignatureHeader('v1=aaa')).toBeNull();
    expect(parseSignatureHeader('t=1')).toBeNull();
    expect(parseSignatureHeader('')).toBeNull();
  });
});

describe('verifyStripeSignature', () => {
  it('accepte une signature calculée sur les octets exacts', () => {
    expect(
      verifyStripeSignature({ payload: PAYLOAD, header: validHeader(), secret: SECRET, now: NOW }),
    ).toEqual({ ok: true, timestamp: TIMESTAMP });
  });

  it('refuse un en-tête absent ou vide', () => {
    expect(
      verifyStripeSignature({ payload: PAYLOAD, header: undefined, secret: SECRET, now: NOW }),
    ).toEqual({ ok: false, reason: 'missing-header' });

    expect(
      verifyStripeSignature({ payload: PAYLOAD, header: '   ', secret: SECRET, now: NOW }),
    ).toEqual({ ok: false, reason: 'missing-header' });
  });

  it('refuse un en-tête illisible', () => {
    expect(
      verifyStripeSignature({ payload: PAYLOAD, header: 'n’importe quoi', secret: SECRET, now: NOW }),
    ).toEqual({ ok: false, reason: 'malformed-header' });
  });

  it('refuse une charge dont un seul octet a changé', () => {
    // Le cas central : la signature porte sur les octets, pas sur l'objet. Un
    // corps re-sérialisé — ce que produirait `express.json()` en amont — tombe
    // exactement ici.
    const reserialized = Buffer.from('{ "id": "evt_1", "type": "payment_intent.succeeded" }');

    expect(
      verifyStripeSignature({
        payload: reserialized,
        header: validHeader(),
        secret: SECRET,
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: 'no-matching-signature' });
  });

  it('refuse une signature calculée avec un autre secret', () => {
    const forged = header([
      `t=${TIMESTAMP}`,
      `v1=${computeSignature('whsec_un_autre_secret', TIMESTAMP, PAYLOAD)}`,
    ]);

    expect(
      verifyStripeSignature({ payload: PAYLOAD, header: forged, secret: SECRET, now: NOW }),
    ).toEqual({ ok: false, reason: 'no-matching-signature' });
  });

  it('accepte quand l’une des signatures annoncées correspond — rotation de secret', () => {
    // Pendant une rotation, Stripe signe avec l'ancien **et** le nouveau secret.
    // Refuser dès qu'une signature ne correspond pas couperait la réception
    // pendant toute la fenêtre de rotation.
    const rotating = header([
      `t=${TIMESTAMP}`,
      `v1=${computeSignature('whsec_ancien', TIMESTAMP, PAYLOAD)}`,
      `v1=${computeSignature(SECRET, TIMESTAMP, PAYLOAD)}`,
    ]);

    expect(
      verifyStripeSignature({ payload: PAYLOAD, header: rotating, secret: SECRET, now: NOW }),
    ).toEqual({ ok: true, timestamp: TIMESTAMP });
  });

  it('refuse une signature qui n’a pas la forme d’un condensat, sans lever', () => {
    // `timingSafeEqual` lève sur deux tampons de longueurs différentes. Une
    // candidate mal dimensionnée doit donc être écartée avant lui, sinon le
    // refus devient un 500.
    for (const candidate of ['', 'court', 'z'.repeat(64), 'a'.repeat(63), 'a'.repeat(65)]) {
      expect(
        verifyStripeSignature({
          payload: PAYLOAD,
          header: header([`t=${TIMESTAMP}`, `v1=${candidate}`]),
          secret: SECRET,
          now: NOW,
        }),
      ).toEqual({ ok: false, reason: 'no-matching-signature' });
    }
  });

  it('refuse une livraison plus vieille que la tolérance', () => {
    const tooOld = NOW + (DEFAULT_TOLERANCE_SECONDS + 1) * 1000;

    expect(
      verifyStripeSignature({ payload: PAYLOAD, header: validHeader(), secret: SECRET, now: tooOld }),
    ).toEqual({ ok: false, reason: 'timestamp-out-of-tolerance' });
  });

  it('refuse une livraison horodatée trop loin dans l’avenir', () => {
    // La fenêtre est symétrique : une horloge de rejeu réglée en avant ne doit
    // pas offrir une signature valable indéfiniment.
    const tooEarly = NOW - (DEFAULT_TOLERANCE_SECONDS + 1) * 1000;

    expect(
      verifyStripeSignature({
        payload: PAYLOAD,
        header: validHeader(),
        secret: SECRET,
        now: tooEarly,
      }),
    ).toEqual({ ok: false, reason: 'timestamp-out-of-tolerance' });
  });

  it('accepte au bord exact de la tolérance', () => {
    const atLimit = NOW + DEFAULT_TOLERANCE_SECONDS * 1000;

    expect(
      verifyStripeSignature({ payload: PAYLOAD, header: validHeader(), secret: SECRET, now: atLimit })
        .ok,
    ).toBe(true);
  });

  it('n’accepte pas la signature d’une autre livraison au même instant', () => {
    // La charge fait partie du condensat : deux événements différents signés à
    // la même seconde n'ont pas la même signature.
    const other = Buffer.from('{"id":"evt_2","type":"charge.refunded"}', 'utf8');

    expect(
      verifyStripeSignature({
        payload: other,
        header: validHeader(TIMESTAMP, PAYLOAD),
        secret: SECRET,
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: 'no-matching-signature' });
  });

  it('lie l’horodatage à la charge signée', () => {
    // Rejouer une signature valide sous un horodatage plus récent — pour passer
    // la tolérance — ne marche pas : `t` entre dans le condensat.
    const recent = TIMESTAMP + 100;
    const spoofed = header([`t=${recent}`, `v1=${computeSignature(SECRET, TIMESTAMP, PAYLOAD)}`]);

    expect(
      verifyStripeSignature({
        payload: PAYLOAD,
        header: spoofed,
        secret: SECRET,
        now: recent * 1000,
      }),
    ).toEqual({ ok: false, reason: 'no-matching-signature' });
  });
});
