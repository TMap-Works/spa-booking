'use client';

import type { StaffMemberSummary } from '@spa/shared';
import type { ReactNode } from 'react';

import { Avatar, avatarClasses } from '@/components/ui/avatar';
import { Icon } from '@/components/ui/icon';

/**
 * Le libellé de l'absence de préférence.
 *
 * `BM-PRATICIEN-01` admet les deux formulations — *« Sans préférence » (ou
 * « Premier disponible »)* —, et c'est la seconde que le produit emploie déjà
 * partout ailleurs : la barre de résumé (`summary-bar.tsx`), le récapitulatif
 * (`steps/recap.tsx`), l'étape du créneau et le tiroir du back-office. En
 * introduire une troisième ici ferait nommer la même chose de deux façons sur le
 * même parcours, ce que le critère `ds:libelles` relève comme un défaut.
 */
export const NO_PREFERENCE_LABEL = 'Premier disponible';

/** Ce que l'option rapporte à la cliente — `BM-PRATICIEN-01`. */
export const NO_PREFERENCE_BENEFIT = 'Le plus de créneaux';

/**
 * Le constat qu'une prestation que personne ne pratique n'a pas de créneau à
 * offrir.
 *
 * Exporté parce que l'étape « créneau » l'écrit aussi (#1049) : le choix du
 * praticien y est une puce qui ouvre un panneau, et ouvrir un panneau pour y lire
 * qu'il n'y a personne est un geste perdu — la phrase se lit donc à la place de
 * la puce. Une seule fois dans le produit : `ds:libelles` relève comme un défaut
 * la même chose nommée de deux façons sur un seul parcours.
 */
export const NO_STAFF_NOTICE =
  'Aucun praticien ne propose cette prestation actuellement : le salon n’a aucun créneau à offrir pour elle.';

interface StaffChoiceProps {
  /** Les praticiens **actifs** qui tiennent la prestation retenue. */
  readonly staff: readonly StaffMemberSummary[];
  /** `null` = « premier disponible » (CDC §1.4), pas « pas encore choisi ». */
  readonly value: string | null;
  readonly onSelect: (staffId: string | null) => void;
}

/**
 * Le choix du praticien, en cartes (#1048).
 *
 * ## Ce qu'il remplace
 *
 * Une `<select>` posée sous la liste des prestations, grisée tant qu'aucune
 * prestation n'était retenue, suivie d'une phrase d'explication. L'audit
 * `d20260918-1` la relève à deux titres :
 *
 * - `BM-PRATICIEN-01` — *« "Sans préférence" d'abord, avec ce qu'il rapporte »* :
 *   l'option ouvrait bien la liste, mais ne disait pas pourquoi la choisir, et
 *   il fallait déplier un contrôle pour la voir ;
 * - `BM-PRATICIEN-02` — *« un visage, sinon des initiales »* : aucun repère
 *   visuel, pas même une pastille.
 *
 * Une liste déroulante demande deux gestes au doigt — ouvrir, puis viser une
 * ligne de 24 px — là où une rangée de cartes n'en demande qu'un, et le critère
 * d'acceptation de l'issue l'écrit : *« le praticien se choisit sans liste
 * déroulante, au clavier comme au doigt »*. Des boutons radio natifs donnent le
 * clavier sans un attribut `aria` : flèches, position dans le groupe, nom porté
 * par le `<label>` qui enveloppe le contrôle.
 *
 * ## Le « métier » n'existe pas dans le contrat, et ne s'invente pas
 *
 * La direction proposée par l'issue dessine des cartes *« `Avatar` + prénom +
 * métier »*. `staffMemberSummarySchema` ne porte que `id` et `displayName`
 * (`packages/shared/src/schemas/catalog.ts`) : il n'y a pas de fonction à
 * afficher, et en fabriquer une serait écrire sur l'écran d'un salon un métier
 * que personne n'y a saisi. C'est exactement le constat que `salon-team.tsx` a
 * déjà posé pour `BM-VITRINE-06`, et la même conclusion s'impose ici. La rubrique
 * pratiquée, qui qualifie le praticien sur la vitrine, ne dirait rien de plus à
 * cette étape : tous les praticiens proposés tiennent la **même** prestation,
 * celle qui vient d'être retenue.
 *
 * La photo, elle, viendra par `Avatar` (#1044) le jour où le modèle de données en
 * portera une — sans toucher à ce fichier.
 *
 * ## Ce qui s'affiche quand personne ne pratique la prestation
 *
 * Pas une rangée vide : le constat écrit. `PublicService.staff` ne liste que les
 * praticiens actifs, et vide il ne veut pas seulement dire « personne n'est
 * affecté » mais « personne ne peut honorer ce soin » — c'est la lecture que la
 * vitrine en fait déjà, ligne par ligne (`service-catalog.tsx`).
 */
export function StaffChoice({ staff, value, onSelect }: StaffChoiceProps) {
  return (
    <fieldset className="spa-booking__staff">
      <legend className="spa-booking__staff-legend">Praticien</legend>

      {staff.length === 0 ? (
        <p className="spa-booking__staff-empty">{NO_STAFF_NOTICE}</p>
      ) : (
        <>
          <div className="spa-booking__staff-row">
            <StaffOption
              // `BM-PRATICIEN-01` : en tête, et avec ce qu'elle rapporte.
              // `Avatar` ne rend que des **initiales**, et « Premier disponible »
              // n'est personne : sa pastille loge un pictogramme. Elle demande
              // donc ses classes à `avatarClasses()` (#1079) au lieu de les
              // recopier — la même mesure et le même ton que les pastilles de
              // praticien juste à côté, sans chaîne à maintenir en double.
              avatar={
                <span aria-hidden="true" className={avatarClasses('md')}>
                  <Icon name="users" />
                </span>
              }
              name={NO_PREFERENCE_LABEL}
              note={NO_PREFERENCE_BENEFIT}
              onSelect={() => {
                onSelect(null);
              }}
              selected={value === null}
              value=""
            />

            {staff.map((member) => (
              <StaffOption
                // Décoratif : le nom est écrit juste en dessous, et un lecteur
                // d'écran annoncerait sinon deux fois « Hery ».
                avatar={<Avatar name={member.displayName} size="md" />}
                key={member.id}
                name={member.displayName}
                note={null}
                onSelect={() => {
                  onSelect(member.id);
                }}
                selected={value === member.id}
                value={member.id}
              />
            ))}
          </div>

          <p className="spa-booking__staff-hint">
            Sans préférence, le salon vous attribue le premier praticien disponible.
          </p>
        </>
      )}
    </fieldset>
  );
}

interface StaffOptionProps {
  readonly avatar: ReactNode;
  readonly name: string;
  /** La ligne qui dit ce que l'option rapporte, ou `null`. */
  readonly note: string | null;
  readonly selected: boolean;
  readonly value: string;
  readonly onSelect: () => void;
}

/** Une carte de praticien — un `<label>` qui enveloppe son bouton radio. */
function StaffOption({ avatar, name, note, selected, value, onSelect }: StaffOptionProps) {
  return (
    <label className="spa-booking__staff-option">
      <input
        checked={selected}
        className="spa-booking__staff-input"
        name="praticien"
        onChange={onSelect}
        type="radio"
        value={value}
      />

      <span className="spa-booking__staff-figure">
        {avatar}

        {/* La coche — le signal non chromatique de l'état retenu, le même que
            celui des lignes de prestation. Décorative : l'état est porté par le
            bouton radio qu'enveloppe ce `<label>`. */}
        <span className="spa-booking__staff-check" aria-hidden="true">
          <Icon name="check" className="spa-booking__staff-check-mark" />
        </span>
      </span>

      <span className="spa-booking__staff-name">{name}</span>
      {note === null ? null : <span className="spa-booking__staff-note">{note}</span>}
    </label>
  );
}
