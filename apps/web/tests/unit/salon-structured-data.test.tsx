/**
 * Données structurées et rendu serveur de la page publique du salon (#43).
 *
 * Deux critères d'acceptation sont vérifiés ici plutôt qu'à l'œil :
 *
 * - « Server Component, sans "use client" au niveau de la page » — la directive
 *   est cherchée dans les fichiers, parce qu'elle se glisse dans un composant
 *   au premier `useState` ajouté par commodité et fait alors basculer toute la
 *   page côté client, LCP et indexation compris ;
 * - « Métadonnées SEO et données structurées » — le graphe est un objet, il
 *   s'inspecte comme un objet.
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PublicService } from '@spa/shared';
import { describe, expect, it } from 'vitest';

import { buildSalonGraph, serializeJsonLd } from '@/components/salon/structured-data';

import { service, tenant } from './fixtures';

const webRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const salonComponents = path.join(webRoot, 'components', 'salon');

const URL_SALON = 'https://reservation.test/maison-lotus';
const URL_RESERVATION = `${URL_SALON}/reservation`;

/** Le graphe, relu comme un objet JSON quelconque — c'est ce que fait un crawler. */
function graphOf(services: readonly PublicService[]): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify(buildSalonGraph(tenant, services, URL_SALON, URL_RESERVATION)),
  ) as Record<string, unknown>;
}

/**
 * Le fichier privé de ses commentaires.
 *
 * La directive ne compte que si elle est la **première instruction** du
 * fichier : c'est ce que cherche cette suite, et non l'occurrence de la chaîne
 * — que ces mêmes fichiers écrivent en toutes lettres pour expliquer pourquoi
 * ils s'en passent.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

describe('la page reste un Server Component', () => {
  it('ni la page ni ses composants n’ouvrent sur une directive client', () => {
    const files = [
      path.join(webRoot, 'app', '(booking)', '[tenantSlug]', 'page.tsx'),
      path.join(webRoot, 'app', '(booking)', '[tenantSlug]', 'salon-data.ts'),
      ...readdirSync(salonComponents).map((name) => path.join(salonComponents, name)),
    ];

    // Le garde-fou n'a de valeur que s'il regarde bien tous les fichiers.
    expect(files.length).toBeGreaterThan(4);

    for (const file of files) {
      const source = withoutComments(readFileSync(file, 'utf8'));

      expect(
        /^\s*(['"])use client\1/.test(source),
        `${path.basename(file)} s’ouvre sur une directive "use client"`,
      ).toBe(false);
    }
  });
});

describe('graphe schema.org', () => {
  it('décrit l’établissement et renvoie vers la réservation', () => {
    const graph = graphOf([service]);

    expect(graph['@context']).toBe('https://schema.org');
    expect(graph['@type']).toBe('HealthAndBeautyBusiness');
    expect(graph['name']).toBe('Maison Lotus');
    expect(graph['url']).toBe(URL_SALON);
    expect(graph['potentialAction']).toMatchObject({
      '@type': 'ReserveAction',
      target: { urlTemplate: URL_RESERVATION },
    });
  });

  it('n’invente ni adresse ni horaires que l’API ne sert pas', () => {
    const graph = graphOf([service]);

    expect(graph['address']).toBeUndefined();
    expect(graph['openingHoursSpecification']).toBeUndefined();
  });

  it('publie les coordonnées quand le salon en a', () => {
    const withContact = buildSalonGraph(
      { ...tenant, contactEmail: 'contact@lotus.test', contactPhone: '+261341234567' },
      [service],
      URL_SALON,
      URL_RESERVATION,
    ) as Record<string, unknown>;

    expect(withContact['email']).toBe('contact@lotus.test');
    expect(withContact['telephone']).toBe('+261341234567');
    expect(graphOf([service])['email']).toBeUndefined();
  });

  it('expose un sous-catalogue par rubrique et un prix en unité principale', () => {
    const catalog = graphOf([service]).hasOfferCatalog as {
      readonly itemListElement: readonly {
        readonly name: string;
        readonly itemListElement: readonly Record<string, unknown>[];
      }[];
    };

    expect(catalog.itemListElement).toHaveLength(1);
    expect(catalog.itemListElement[0]?.name).toBe('Massages');

    const offer = catalog.itemListElement[0]?.itemListElement[0];

    // 3500 centimes d'euro → « 35.00 », point décimal compris : c'est la forme
    // que schema.org attend, et elle n'a rien à voir avec l'affichage humain.
    expect(offer?.['price']).toBe('35.00');
    expect(offer?.['priceCurrency']).toBe('EUR');
    expect(offer?.['itemOffered']).toMatchObject({ '@type': 'Service', name: 'Massage suédois' });
  });

  it('omet le catalogue plutôt que d’en publier un vide', () => {
    expect(graphOf([])['hasOfferCatalog']).toBeUndefined();
  });
});

describe('sérialisation du script', () => {
  it('neutralise une balise fermante glissée dans un nom saisi par le salon', () => {
    const hostile = serializeJsonLd(
      buildSalonGraph(
        { ...tenant, name: '</script><script>alert(1)</script>' },
        [],
        URL_SALON,
        URL_RESERVATION,
      ),
    );

    expect(hostile.includes('</script>')).toBe(false);
    expect(hostile.includes('\\u003c/script>')).toBe(true);
    // Et cela reste du JSON valide, sans quoi le graphe serait simplement ignoré.
    expect((JSON.parse(hostile) as { readonly name: string }).name).toBe(
      '</script><script>alert(1)</script>',
    );
  });
});
