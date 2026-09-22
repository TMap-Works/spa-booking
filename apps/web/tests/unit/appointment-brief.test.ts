import type { BookedAppointment, PublicTenant } from '@spa/shared';
import { describe, expect, it } from 'vitest';

import {
  addressOneLine,
  appointmentBrief,
  appointmentIcs,
  appointmentIcsFilename,
  appointmentIcsHref,
  appointmentTimeRange,
  directionsUrl,
  pendingHoldNote,
  rescheduledNote,
  serviceFallback,
} from '@/components/account/appointment-brief';

import { service, tenant } from './fixtures';

/**
 * La logique de présentation de la carte de rendez-vous — #1053.
 *
 * Elle se teste sans DOM parce qu'elle n'en a pas besoin (web-frontend §8) :
 * résoudre un nom de praticien, composer une plage horaire et écrire un fichier
 * iCalendar sont trois fonctions, et trois assertions valent mieux qu'un rendu
 * qu'on relit à l'œil.
 */

const APPOINTMENT: BookedAppointment = {
  id: '3f7c1f4e-2a9d-4c53-8f0e-1b2c3d4e5f60',
  reference: 'RDV-8F3K-27',
  status: 'confirmed',
  serviceId: service.id,
  staffId: service.staff[0]?.id ?? '',
  clientId: '9a8b7c6d-5e4f-4a3b-9c8d-7e6f5a4b3c2f',
  startsAt: '2026-09-21T08:00:00.000Z',
  endsAt: '2026-09-21T09:10:00.000Z',
  price: { amountMinor: 3500, currency: 'EUR' },
  clientNote: null,
  rescheduledFromId: null,
  cancelledAt: null,
  cancelledBy: null,
};

const ADDRESS = {
  line1: '12 rue des Lilas',
  postalCode: '101',
  city: 'Antananarivo',
  country: 'MG',
};

/** L'établissement de la fixture, complété de ce que la carte héros affiche. */
const SALON: PublicTenant = {
  ...tenant,
  contactPhone: '+261 34 12 345 67',
  address: ADDRESS,
};

describe('appointmentBrief — les noms que le contrat public ne sert pas', () => {
  it('résout la prestation et le praticien à partir des identifiants', () => {
    const brief = appointmentBrief(APPOINTMENT, [service]);

    expect(brief.serviceName).toBe('Massage suédois');
    // `BM-RDV-02` reproche nommément à Planity de taire le praticien réservé.
    expect(brief.practitioner).toBe('Hery');
  });

  it('se tait plutôt que d’inventer quand la prestation a quitté le catalogue', () => {
    // Le catalogue **public** ne porte que les prestations en vente : un soin
    // retiré depuis laisse une carte sans nom, jamais un nom approximatif.
    const brief = appointmentBrief(APPOINTMENT, []);

    expect(brief.serviceName).toBeNull();
    expect(brief.practitioner).toBeNull();
  });

  it('se tait aussi quand le praticien a été désactivé', () => {
    const brief = appointmentBrief({ ...APPOINTMENT, staffId: 'inconnu' }, [service]);

    expect(brief.serviceName).toBe('Massage suédois');
    expect(brief.practitioner).toBeNull();
  });

  it('tient la durée des bornes du rendez-vous, et non du catalogue', () => {
    // Le prix est figé à la réservation ; la durée doit l'être de la même façon.
    // La prestation du catalogue dure 60 minutes, ce rendez-vous en dure 70.
    expect(service.durationMinutes).toBe(60);
    expect(appointmentBrief(APPOINTMENT, [service]).durationMinutes).toBe(70);
  });
});

describe('appointmentTimeRange — l’heure de fin, que la ligne d’historique taisait', () => {
  it('écrit les deux bornes dans le fuseau du salon', () => {
    // `Indian/Antananarivo` est en UTC+3 et ne pratique pas l'heure d'été : un
    // affichage qui aurait oublié le fuseau du salon rendrait « 08:00 ».
    expect(appointmentTimeRange(APPOINTMENT, 'Indian/Antananarivo')).toBe('11:00 – 12:10');
  });

  it('encadre le tiret d’espaces insécables', () => {
    // Sans elles, un retour à la ligne tombe entre l'heure et le tiret, et la
    // plage se lit comme deux heures sans rapport.
    expect(appointmentTimeRange(APPOINTMENT, 'UTC')).toContain(' – ');
  });
});

describe('directionsUrl — l’itinéraire de BM-RDV-04', () => {
  it('vise l’adresse du salon, nom et pays compris', () => {
    const url = directionsUrl(SALON);

    expect(url).toContain('destination=');
    expect(decodeURIComponent(url ?? '')).toContain(
      'Maison Lotus, 12 rue des Lilas, 101 Antananarivo, Madagascar',
    );
  });

  it('ne promet rien quand le salon n’a pas publié d’adresse', () => {
    // Une action qu'on ne peut pas exercer n'est pas une action.
    expect(directionsUrl(tenant)).toBeNull();
  });

  it('garde le pays, sans quoi la destination se géocode ailleurs', () => {
    // Le nom du salon ouvre la ligne, l'adresse la termine par son pays en
    // toutes lettres : « 12 rue des Lilas, Paris » existe aussi en France, et
    // c'est là qu'un itinéraire sans pays enverrait la cliente.
    expect(addressOneLine(SALON.name, ADDRESS)).toBe(
      'Maison Lotus, 12 rue des Lilas, 101 Antananarivo, Madagascar',
    );
  });
});

describe('appointmentIcs — le rendez-vous dans l’agenda du téléphone (BM-RDV-03)', () => {
  const ics = appointmentIcs({ brief: appointmentBrief(APPOINTMENT, [service]), tenant: SALON });

  it('est un VEVENT complet, en UTC', () => {
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain('BEGIN:VEVENT');
    // Le `Z` déclare l'UTC : l'agenda de la cliente reprojettera dans le sien.
    expect(ics).toContain('DTSTART:20260921T080000Z');
    expect(ics).toContain('DTEND:20260921T091000Z');
    expect(ics).toContain('END:VCALENDAR');
  });

  it('nomme la prestation, le salon, le praticien et le lieu', () => {
    expect(ics).toContain('SUMMARY:Massage suédois — Maison Lotus');
    expect(ics).toContain('DESCRIPTION:Avec Hery');
    expect(ics).toContain('LOCATION:Maison Lotus');
  });

  it('échappe la virgule, que la RFC 5545 prend pour un séparateur de valeurs', () => {
    // L'adresse en porte une : sans échappement, `LOCATION` serait coupée en
    // deux et l'agenda n'afficherait que le nom du salon.
    expect(ics).toContain('LOCATION:Maison Lotus\\, 12 rue des Lilas\\, 101 Antananarivo\\, Madagascar');
  });

  it('sépare ses lignes par CRLF, comme la RFC l’impose', () => {
    expect(ics.split('\r\n').length).toBeGreaterThan(10);
    expect(ics.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('plie les lignes au-delà de 75 octets, sans couper un caractère', () => {
    const long = appointmentIcs({
      brief: {
        appointment: APPOINTMENT,
        serviceName: 'Rituel signature à l’huile de monoï et modelage crânien prolongé',
        practitioner: 'Hery',
        durationMinutes: 70,
      },
      tenant: SALON,
    });

    for (const line of long.split('\r\n')) {
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    }
    // Le pliage est réversible : le dépliage rend le libellé intact, accents
    // compris — c'est ce qu'une coupe au milieu d'un caractère détruirait.
    expect(long.replace(/\r\n /g, '')).toContain('monoï et modelage crânien prolongé');
  });

  it('se télécharge sous la référence citable, jamais sous un UUID', () => {
    expect(appointmentIcsFilename(APPOINTMENT)).toBe('rendez-vous-RDV-8F3K-27.ics');
  });

  it('s’écrit en URL de données, posable telle quelle sur un lien', () => {
    const href = appointmentIcsHref({
      brief: appointmentBrief(APPOINTMENT, [service]),
      tenant: SALON,
    });

    expect(href.startsWith('data:text/calendar;charset=utf-8,')).toBe(true);
    expect(decodeURIComponent(href)).toContain('BEGIN:VEVENT');
  });

  it('se dit en anglais quand l’écran est en anglais (#847)', () => {
    // Le fichier finit dans l'agenda du téléphone, où il sera relu des mois
    // après : son résumé et sa description sont du texte d'interface comme les
    // autres. Le protocole de la RFC 5545, lui, ne se traduit pas — mêmes
    // `DTSTART`, même `UID`, même pliage.
    const english = appointmentIcs({
      brief: appointmentBrief(APPOINTMENT, [service]),
      tenant: SALON,
      locale: 'en',
    });

    expect(english).toContain('DESCRIPTION:With Hery');
    expect(english).toContain('DTSTART:20260921T080000Z');
    expect(appointmentIcsFilename(APPOINTMENT, 'en')).toBe('appointment-RDV-8F3K-27.ics');
  });
});

describe('les phrases de statut de l’espace client (#847)', () => {
  it('se disent dans les deux langues, et le français reste le défaut', () => {
    // Le défaut est français parce que les suites de ce dépôt sont écrites en
    // français (`tests/support/next-intl.ts`) — pas parce que le produit l'est :
    // `DEFAULT_LOCALE` du contrat vaut `en`.
    expect(pendingHoldNote()).toBe('Votre créneau est retenu ; rien à faire de votre côté.');
    expect(pendingHoldNote('en')).toBe('Your slot is held; there is nothing for you to do.');
    expect(rescheduledNote('fr')).toBe('Ce créneau a été libéré au profit d’un autre rendez-vous.');
    expect(rescheduledNote('en')).toBe(
      'This slot was released in favour of another appointment.',
    );
  });

  it('nomme une prestation disparue du catalogue dans la langue de l’écran', () => {
    expect(serviceFallback('fr')).toBe('Prestation');
    expect(serviceFallback('en')).toBe('Service');
  });
});

describe('appointmentTimeRange — la plage suit la langue, jamais le fuseau (#847)', () => {
  it('écrit la même heure de salon de deux façons', () => {
    const range = { startsAt: APPOINTMENT.startsAt, endsAt: APPOINTMENT.endsAt };
    /**
     * Toute espace ramenée à l'espace ordinaire.
     *
     * `Intl` en insère deux sortes d'insécables — U+00A0 autour du tiret de la
     * plage, U+202F avant « AM » en `en-US` —, et une suite qui comparerait les
     * codets bruts échouerait sur un caractère que personne ne voit. C'est la
     * **mise en forme** qu'on éprouve ici, pas la typographie d'ICU.
     *
     * `\s` et non une classe de deux codets : la classe aurait porté ces
     * caractères en clair dans la source, ce que `no-irregular-whitespace`
     * refuse — à raison, une espace insécable écrite à la main dans du code ne
     * se distingue d'une espace ordinaire par rien.
     */
    const lisible = (text: string): string => text.replace(/\s/g, ' ');

    // 08:00 UTC à Antananarivo (UTC+3) est 11:00 dans les deux langues : c'est
    // l'écriture qui change, pas l'instant ni le fuseau.
    expect(lisible(appointmentTimeRange(range, 'Indian/Antananarivo', { locale: 'fr' }))).toBe(
      '11:00 – 12:10',
    );
    expect(lisible(appointmentTimeRange(range, 'Indian/Antananarivo', { locale: 'en' }))).toBe(
      '11:00 AM – 12:10 PM',
    );
  });
});
