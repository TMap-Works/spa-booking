import { cleanup, render, screen } from '@testing-library/react';
import Link from 'next/link';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SalonHeader } from '@/components/salon/salon-header';
import { LinkPending } from '@/components/ui/link-pending';

import { tenant } from './fixtures';

/*
 * Le repère « en cours » du lien cliqué (#830).
 *
 * `useLinkStatus` ne répond `pending` que sous le routeur de l'App Router, que
 * cette suite n'a pas : il est donc piloté ici. Ce que la suite protège :
 *
 * - le repère suit l'état du lien, et ne dit rien au repos ;
 * - il ne change ni le nom accessible du lien ni sa place — un lien du rail ou
 *   « Prendre rendez-vous » garde le libellé par lequel le parcours E2E le
 *   clique (`tests/e2e/support/scene.ts`).
 */

let pending = false;

vi.mock('next/link', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/link')>()),
  useLinkStatus: () => ({ pending }),
}));

afterEach(() => {
  cleanup();
  pending = false;
});

function marker(container: HTMLElement): Element | null {
  return container.querySelector('.spa-link-pending');
}

describe('repère « en cours » d’un lien', () => {
  it('est posé au repos, sans rien annoncer ni montrer', () => {
    const { container } = render(
      <Link href="/maison-lotus/admin/clients">
        Clients
        <LinkPending />
      </Link>,
    );

    expect(marker(container)).not.toBeNull();
    expect(marker(container)?.getAttribute('aria-hidden')).toBe('true');
    expect(marker(container)?.hasAttribute('data-pending')).toBe(false);
  });

  it('se dit en cours pendant la navigation du lien', () => {
    pending = true;

    const { container } = render(
      <Link href="/maison-lotus/admin/clients">
        Clients
        <LinkPending className="spa-admin__nav-pending" />
      </Link>,
    );

    expect(marker(container)?.getAttribute('data-pending')).toBe('true');
    expect(marker(container)?.classList.contains('spa-admin__nav-pending')).toBe(true);
  });

  it('ne change pas le nom du lien qui l’accueille', () => {
    pending = true;

    render(
      <Link href="/maison-lotus/admin/clients">
        Clients
        <LinkPending />
      </Link>,
    );

    expect(screen.getByRole('link', { name: 'Clients' })).not.toBeNull();
  });
});

describe('« Prendre rendez-vous » sur la vitrine', () => {
  it('garde son nom et sa cible, et porte le repère à la place du spinner d’un bouton', () => {
    pending = true;

    render(<SalonHeader tenant={tenant} reservationHref={`/${tenant.slug}/reservation`} />);

    const reserver = screen.getByRole('link', { name: 'Prendre rendez-vous' });
    expect(reserver.getAttribute('href')).toBe(`/${tenant.slug}/reservation`);
    // Le libellé est rangé dans `.spa-button__label` : c'est lui que la feuille
    // efface, à largeur conservée, quand le repère apparaît.
    expect(reserver.querySelector('.spa-button__label')?.textContent).toBe('Prendre rendez-vous');
    expect(reserver.querySelector('.spa-link-pending')?.getAttribute('data-pending')).toBe('true');
  });
});
