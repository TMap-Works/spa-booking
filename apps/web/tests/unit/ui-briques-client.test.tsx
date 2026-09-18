import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import Link from 'next/link';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Avatar, avatarClasses, initialsOf } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { DateBlock, dateBlockParts } from '@/components/ui/date-block';
import { EmptyState } from '@/components/ui/empty-state';
import { NavTabs } from '@/components/ui/nav-tabs';
import { PasswordField } from '@/components/ui/password-field';
import { Sheet } from '@/components/ui/sheet';
import { Tabs, tabPanelProps } from '@/components/ui/tabs';

/*
 * Les briques de présentation du parcours client (#1044).
 *
 * Ce que la suite protège, brique par brique : ce qu'un lecteur d'écran en
 * entend (nom, état, rôle), et le seul calcul qu'elles portent — les initiales,
 * les morceaux d'une date dans le fuseau du salon.
 */

afterEach(cleanup);

describe('Badge', () => {
  it('écrit son libellé et porte sa tonalité en classe', () => {
    render(<Badge tone="pending">À confirmer par le salon</Badge>);
    const badge = screen.getByText('À confirmer par le salon');
    expect(badge.className).toBe('spa-badge spa-badge--pending');
  });

  it('est neutre par défaut', () => {
    render(<Badge>Brouillon</Badge>);
    expect(screen.getByText('Brouillon').className).toContain('spa-badge--neutral');
  });
});

describe('Avatar', () => {
  it.each([
    ['Yanis B.', 'YB'],
    ['Spa Lumière', 'SL'],
    ['claire', 'C'],
    ['Jean-Pierre Martin', 'JM'],
    ['Élodie', 'É'],
    ['Spa & Salon Booking', 'SB'],
    ['   ', '?'],
  ])('« %s » → %s', (name, initials) => {
    expect(initialsOf(name)).toBe(initials);
  });

  it('reste décoratif à côté d’un nom écrit', () => {
    const { container } = render(<Avatar name="Yanis B." />);
    const avatar = container.querySelector('.spa-avatar');
    expect(avatar?.getAttribute('aria-hidden')).toBe('true');
    expect(avatar?.textContent).toBe('YB');
  });

  it('porte un nom quand il est seul', () => {
    render(<Avatar name="Alice Marchand" label="Compte d’Alice Marchand" />);
    expect(screen.getByRole('img', { name: 'Compte d’Alice Marchand' })).toBeTruthy();
  });

  /*
   * Une pastille ne loge pas toujours des initiales : « Premier disponible »
   * n'est personne, et `staff-choice.tsx` y met un pictogramme (#1079). C'est la
   * raison d'être de `avatarClasses` — et ce que cette paire de tests tient,
   * c'est qu'elle et `Avatar` ne puissent pas diverger.
   */
  it('compose les classes d’une pastille sans la rendre', () => {
    expect(avatarClasses('lg', 'square', 'brand')).toBe(
      'spa-avatar spa-avatar--lg spa-avatar--square spa-avatar--brand',
    );
    // Les mêmes défauts qu'`Avatar` : une pastille demandée sans précision est
    // ronde, moyenne et d'accent.
    expect(avatarClasses()).toBe('spa-avatar spa-avatar--md spa-avatar--circle spa-avatar--accent');
  });

  it('rend exactement les classes que `avatarClasses` compose', () => {
    const { container } = render(<Avatar name="Spa Lumière" size="xl" shape="square" tone="brand" />);

    expect(container.querySelector('.spa-avatar')?.className).toBe(
      avatarClasses('xl', 'square', 'brand'),
    );
  });
});

describe('DateBlock', () => {
  it('lit un instant dans le fuseau du salon, pas dans celui du navigateur', () => {
    // 22:30 UTC le 18 est déjà le samedi 19 à Paris (UTC+2).
    const parts = dateBlockParts({ instant: '2026-09-18T22:30:00.000Z', timeZone: 'Europe/Paris' });
    expect(parts).toMatchObject({ weekday: 'sam', day: '19', month: 'sept' });
    expect(parts.full).toBe('samedi 19 septembre 2026');
  });

  it('ne fait glisser aucune date civile', () => {
    const parts = dateBlockParts({ date: '2026-09-21' });
    expect(parts).toMatchObject({ weekday: 'lun', day: '21', month: 'sept', machine: '2026-09-21' });
  });

  it('se lit en toutes lettres, les morceaux masqués', () => {
    const { container } = render(<DateBlock date="2026-09-21" size="lg" />);
    const time = container.querySelector('time');
    expect(time?.getAttribute('datetime')).toBe('2026-09-21');
    expect(time?.className).toContain('spa-date-block--lg');
    expect(screen.getByText('lundi 21 septembre 2026').className).toBe('spa-visually-hidden');
    expect(screen.getByText('21').getAttribute('aria-hidden')).toBe('true');
  });
});

describe('EmptyState', () => {
  it('nomme l’absence et propose d’en sortir', () => {
    render(
      <EmptyState title="Aucun rendez-vous à venir" titleAs="h3" action={<Link href="/r">Prendre rendez-vous</Link>}>
        Choisissez une prestation et un créneau.
      </EmptyState>,
    );
    expect(screen.getByRole('heading', { level: 3, name: 'Aucun rendez-vous à venir' })).toBeTruthy();
    expect(screen.getByText('Choisissez une prestation et un créneau.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Prendre rendez-vous' })).toBeTruthy();
  });
});

/** `marked` : l'identifiant de la rubrique qui porte la marque, s'il y en a une. */
function Categories({ marked, markedLabel }: { marked?: string; markedLabel?: string }) {
  const [value, setValue] = useState('massages');
  // `exactOptionalPropertyTypes` : passer `undefined` à une propriété optionnelle
  // n'est pas la même chose que ne pas la passer — et c'est bien l'absence qu'on
  // veut éprouver quand l'appelant ne précise rien.
  const wording = markedLabel === undefined ? {} : { markedLabel };

  return (
    <>
      <Tabs
        label="Catégories"
        idPrefix="cat"
        value={value}
        onChange={setValue}
        {...wording}
        items={[
          { id: 'massages', label: 'Massages', count: 2, marked: marked === 'massages' },
          { id: 'visage', label: 'Soins du visage', count: 1, marked: marked === 'visage' },
          { id: 'corps', label: 'Corps', marked: marked === 'corps' },
        ]}
      />
      <div {...tabPanelProps('cat', value)}>{value}</div>
    </>
  );
}

describe('Tabs', () => {
  it('ne laisse qu’un arrêt de tabulation, sur l’onglet actif', () => {
    render(<Categories />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([0, -1, -1]);
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tabpanel', { name: /Massages/ }).textContent).toBe('massages');
  });

  it('passe d’un onglet à l’autre aux flèches, et boucle', () => {
    render(<Categories />);
    const list = screen.getByRole('tablist', { name: 'Catégories' });
    fireEvent.keyDown(list, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { selected: true }).textContent).toContain('Soins du visage');
    expect(document.activeElement?.textContent).toContain('Soins du visage');
    fireEvent.keyDown(list, { key: 'End' });
    expect(screen.getByRole('tab', { selected: true }).textContent).toBe('Corps');
    fireEvent.keyDown(list, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { selected: true }).textContent).toContain('Massages');
  });

  it('dit l’effectif dans le nom de l’onglet', () => {
    render(<Categories />);
    expect(screen.getByRole('tab', { name: 'Massages · 2' })).toBeTruthy();
  });

  /*
   * La marque d'un onglet (#1079, `BM-SERVICE-06`) : ce qui a été retenu est
   * dans ce panneau-là, qu'on l'ait ouvert ou non. Un état distinct de
   * `aria-selected` — l'onglet ouvert est celui qu'on regarde, l'onglet marqué
   * celui où se trouve le choix.
   */
  it('marque l’onglet qui contient ce qui a été retenu, sans le sélectionner', () => {
    render(<Categories marked="corps" />);

    const marque = screen.getByRole('tab', { name: /Corps/ });

    expect(marque.querySelector('.spa-tabs__mark')).toBeTruthy();
    // La marque ne déplace pas l'onglet ouvert : les deux états cohabitent.
    expect(marque.getAttribute('aria-selected')).toBe('false');
    expect(screen.getByRole('tab', { name: /Massages/ }).querySelector('.spa-tabs__mark')).toBeNull();
  });

  it('ne fait pas lire « coche » : le glyphe est décoratif, la phrase est écrite', () => {
    render(<Categories marked="massages" markedLabel="prestation retenue" />);

    // Le pictogramme est masqué aux technologies d'assistance — une coche
    // annoncée à la suite d'un libellé n'apprend rien (`icon.tsx`, WCAG 1.1.1).
    const glyphe = screen.getByRole('tab', { name: /Massages/ }).querySelector('.spa-tabs__mark-icon');
    expect(glyphe?.getAttribute('aria-hidden')).toBe('true');

    // L'information passe donc par du texte, dans le nom accessible de l'onglet,
    // à la suite du libellé et de l'effectif. `TabItem.label` étant une `string`,
    // c'est le seul endroit où elle puisse se ranger.
    expect(screen.getByRole('tab', { name: 'Massages · 2 · prestation retenue' })).toBeTruthy();
  });

  it('dit « contient votre choix » quand l’appelant ne précise rien', () => {
    render(<Categories marked="corps" />);
    expect(screen.getByRole('tab', { name: 'Corps · contient votre choix' })).toBeTruthy();
  });
});

describe('NavTabs', () => {
  it('marque la page courante, sans promettre de panneau', () => {
    render(
      <NavTabs
        label="Mon compte"
        items={[
          { href: '/s/compte', label: 'Mes rendez-vous', current: true },
          { href: '/s/compte/coordonnees', label: 'Mes coordonnées', current: false },
        ]}
      />,
    );
    expect(screen.getByRole('navigation', { name: 'Mon compte' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Mes rendez-vous' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: 'Mes coordonnées' }).getAttribute('aria-current')).toBeNull();
    expect(screen.queryByRole('tab')).toBeNull();
  });
});

describe('Sheet', () => {
  it('s’ouvre, porte son titre, et se ferme par son bouton', () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <Sheet open={false} onClose={onClose} title="Choisir un jour">
        <p>Le mois</p>
      </Sheet>,
    );
    const dialog = document.querySelector('dialog');
    expect(dialog?.hasAttribute('open')).toBe(false);

    rerender(
      <Sheet open onClose={onClose} title="Choisir un jour">
        <p>Le mois</p>
      </Sheet>,
    );
    expect(dialog?.hasAttribute('open')).toBe(true);
    expect(screen.getByRole('dialog', { name: 'Choisir un jour' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Fermer' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('se ferme d’un clic sur le voile, pas d’un clic dans le panneau', () => {
    const onClose = vi.fn();
    render(
      <Sheet open onClose={onClose} title="Praticien">
        <p>Yanis</p>
      </Sheet>,
    );
    fireEvent.click(screen.getByText('Yanis'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(document.querySelector('dialog') as HTMLDialogElement);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('PasswordField', () => {
  it('masque par défaut, affiche à la demande, et le dit', () => {
    render(<PasswordField id="password" label="Mot de passe" autoComplete="current-password" required />);
    const input = screen.getByLabelText(/^Mot de passe/);
    expect(input.getAttribute('type')).toBe('password');

    fireEvent.click(screen.getByRole('button', { name: 'Afficher le mot de passe' }));
    expect(input.getAttribute('type')).toBe('text');
    expect(screen.getByText('Votre mot de passe est affiché.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Masquer le mot de passe' }));
    expect(input.getAttribute('type')).toBe('password');
  });

  it('relie l’aide et l’erreur au champ', () => {
    render(<PasswordField id="pw" label="Mot de passe" hint="Douze caractères au minimum." error="Trop court." />);
    const input = screen.getByLabelText(/^Mot de passe/);
    expect(input.getAttribute('aria-describedby')).toBe('pw-hint pw-error');
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });
});
