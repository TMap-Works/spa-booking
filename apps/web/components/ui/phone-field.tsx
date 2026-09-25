'use client';

import {
  getCountries,
  parsePhoneNumberFromString,
  type CountryCode,
} from 'libphonenumber-js/min';
import metadata from 'libphonenumber-js/min/metadata';
import { useLocale } from 'next-intl';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ComponentType,
  type FocusEvent,
  type KeyboardEvent,
  type Ref,
} from 'react';
import type { Flags, Labels } from 'react-phone-number-input';
import PhoneInputWithCountry from 'react-phone-number-input/core';

import { Icon } from '@/components/ui/icon';
import { usePhoneCountry } from '@/components/ui/phone-country';
import { Sheet } from '@/components/ui/sheet';
import {
  countryName,
  dialCode,
  phoneExample,
  phoneInvalidMessage,
  resolvePhoneCountry,
  resolvePhoneLocale,
  toPhoneInputValue,
  type PhoneLocale,
} from '@/lib/phone';

/**
 * Les types de la bibliothèque déclarent une classe, mais l'export est un
 * `forwardRef` vers l'`<input>` (`modules/PhoneInputWithCountry.js`) : la
 * référence désigne donc le champ de saisie, et c'est ce que
 * `react-hook-form` attend pour y ramener le focus sur une erreur.
 */
const PhoneInput = PhoneInputWithCountry as unknown as ComponentType<
  ComponentProps<typeof PhoneInputWithCountry> & { readonly ref?: Ref<HTMLInputElement> | undefined }
>;

const TEXTS = {
  en: {
    country: 'Country',
    trigger: (name: string, dial: string) => `Country code: ${name} (${dial})`,
    sheetTitle: 'Country code',
    search: 'Search for a country',
    searchPlaceholder: 'Name, code or dialing code',
    list: 'Countries',
    noMatch: (query: string) => `No country matches “${query}”.`,
    results: (count: number) => (count === 1 ? '1 country' : `${String(count)} countries`),
  },
  fr: {
    country: 'Pays',
    trigger: (name: string, dial: string) => `Pays de l’indicatif : ${name} (${dial})`,
    sheetTitle: 'Pays de l’indicatif',
    search: 'Rechercher un pays',
    searchPlaceholder: 'Nom, code ou indicatif',
    list: 'Pays',
    noMatch: (query: string) => `Aucun pays ne correspond à « ${query} ».`,
    results: (count: number) => `${String(count)} pays`,
  },
} as const;

interface PhoneFieldProps {
  readonly id: string;
  readonly label: string;
  readonly hint?: string | undefined;
  /**
   * Le schéma a refusé la valeur.
   *
   * Un drapeau et non un message, à la différence de `Field` : le texte
   * affiché nomme le **pays choisi** (« … pour ce pays (Canada, +1) »), et seul
   * ce champ le connaît — `+1` sert le Canada comme les États-Unis, si bien que
   * le formulaire ne saurait pas le déduire de la valeur (critère 6 de #825).
   */
  readonly invalid?: boolean | undefined;
  readonly required?: boolean | undefined;
  readonly disabled?: boolean | undefined;
  readonly name?: string | undefined;
  /** E.164, ou `''` pour « pas de numéro ». */
  readonly value: string;
  /** Reçoit l'E.164 de la saisie en cours — `''` quand le champ est vidé. */
  readonly onChange: (value: string) => void;
  readonly onBlur?: (() => void) | undefined;
  /**
   * Le pays où la saisie commence, quand l'appelant le connaît mieux que le
   * gabarit — le tunnel public, ou les réglages dont le pays est en cours
   * d'édition. À défaut, celui de `PhoneCountryProvider`.
   */
  readonly defaultCountry?: string | null | undefined;
  /**
   * Force la langue du sélecteur, des noms de pays et du refus du numéro.
   *
   * À omettre : le champ lit la langue de la session (`useLocale()`), comme
   * toute brique du design system. La propriété ne reste que pour l'écran qui
   * saurait, un jour, devoir montrer un numéro dans une autre langue que la
   * sienne — et pour éprouver les deux langues sans monter deux contextes.
   */
  readonly locale?: PhoneLocale | undefined;
  /**
   * `tel` par défaut. Le back-office passe `off` : le comptoir saisit le
   * numéro de quelqu'un d'autre, et le navigateur y proposerait le sien.
   */
  readonly autoComplete?: string | undefined;
  readonly ref?: Ref<HTMLInputElement> | undefined;
}

/**
 * Champ téléphone international (#825) — un sélecteur de pays avec drapeau,
 * indicatif et recherche, une saisie au format **national**, une valeur émise
 * en **E.164**.
 *
 * ## Ce que fait la bibliothèque, et ce qu'elle ne fait pas ici
 *
 * `react-phone-number-input` — bâti sur `libphonenumber-js`, la même
 * bibliothèque que la règle du contrat (#824) — tient la saisie : formatage à
 * la frappe, bascule de pays quand on tape un `+`, valeur E.164. Tout ce qui
 * se voit est à nous :
 *
 * - **le sélecteur de pays** est un bouton qui ouvre le `Sheet` du design
 *   system, avec une recherche : le `<select>` natif de la bibliothèque ne peut
 *   ni montrer un drapeau dans ses options, ni chercher autrement que par la
 *   première lettre ;
 * - **les drapeaux sont embarqués** (`react-phone-number-input/flags`) et
 *   jamais chargés d'un domaine tiers — le défaut de la bibliothèque, qui les
 *   lit sur `purecatamphetamine.github.io`, n'est jamais atteint : son
 *   composant de drapeau n'est pas rendu (critère 3) ;
 * - **aucune feuille de style de la bibliothèque** : `styles/components/phone.css`,
 *   sur les jetons (critère 4).
 *
 * Les drapeaux pèsent une cinquantaine de kilo-octets compressés : ils sont
 * chargés **après** l'affichage (`useFlags`), et un aplat de même taille tient
 * leur place d'ici là. Le tunnel de réservation vise un LCP sous 2,5 s en 4G
 * (skill web-frontend §7) — deux cent quarante drapeaux n'ont rien à faire sur
 * ce chemin-là.
 */
export function PhoneField({
  id,
  label,
  hint,
  invalid = false,
  required = false,
  disabled = false,
  name,
  value,
  onChange,
  onBlur,
  defaultCountry,
  locale,
  autoComplete = 'tel',
  ref,
}: PhoneFieldProps) {
  /**
   * La langue de l'écran (#1267).
   *
   * Lue ici et non reçue de l'appelant : sept formulaires montent ce champ, et
   * le repli `'fr'` posé à titre transitoire par #845 faisait parler français
   * les six qui ne passaient pas la propriété — sélecteur d'indicatif, noms de
   * pays, recherche et refus du numéro compris. Une brique du design system
   * connaît la langue de la session comme elle connaît son thème ; l'appelant
   * n'a plus rien à lui redire.
   */
  const session = useLocale();
  const active = locale ?? resolvePhoneLocale(session);
  const contextCountry = usePhoneCountry();
  const startCountry = resolvePhoneCountry(
    defaultCountry === undefined ? contextCountry : defaultCountry,
  );
  const inputValue = toPhoneInputValue(value, startCountry);
  /**
   * Le pays du drapeau, suivi ici parce que le message d'erreur le nomme.
   *
   * La bibliothèque le tient aussi, et le signale par `onCountryChange` —
   * choix dans la liste, `+` tapé, valeur remplacée par un `reset` du
   * formulaire.
   */
  const [country, setCountry] = useState<CountryCode>(
    () => countryOf(inputValue) ?? startCountry,
  );
  const flags = useFlags();
  const labels = phoneLabels(active);
  const example = phoneExample(country);
  // Stable tant que le champ garde son identifiant : le sélecteur s'en sert
  // comme dépendance d'effet, et ne doit le rappeler qu'à sa fermeture.
  const focusNumber = useCallback(() => {
    document.getElementById(id)?.focus();
  }, [id]);
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint === undefined ? null : hintId, invalid ? errorId : null]
    .filter((part) => part !== null)
    .join(' ');

  return (
    <div className="spa-field spa-phone">
      <label className="spa-field__label" htmlFor={id}>
        {label}
        {required ? (
          <span className="spa-field__required" aria-hidden="true">
            *
          </span>
        ) : null}
      </label>
      <PhoneInput
        // `exactOptionalPropertyTypes` : les propriétés facultatives de la
        // bibliothèque ne prennent pas `undefined`, elles s'omettent.
        {...(name === undefined ? {} : { name })}
        {...(inputValue === undefined ? {} : { value: inputValue })}
        {...(example === undefined ? {} : { placeholder: example })}
        ref={ref}
        id={id}
        metadata={metadata}
        labels={labels}
        locales={active}
        defaultCountry={startCountry}
        // Le pays de l'établissement en tête de liste, puis tous les autres
        // dans l'ordre alphabétique de la langue de l'écran.
        countryOptionsOrder={[startCountry, '|', '...']}
        // L'« international » sans pays n'a pas de sens pour un salon : un `+`
        // tapé bascule de lui-même sur le pays de l'indicatif.
        addInternationalOption={false}
        // Un numéro enregistré se relit comme on l'a tapé — « 06 12 34 56 78 »
        // derrière le drapeau français, et non « +33 6 12 34 56 78 ».
        initialValueFormat="national"
        limitMaxLength
        // Le focus rejoint le numéro **après** la fermeture du panneau : tant
        // que le `<dialog>` est ouvert, le reste de la page est inerte, et un
        // `focus()` y serait sans effet. Voir `onPicked`.
        focusInputOnCountrySelection={false}
        onChange={(next) => {
          onChange(next ?? '');
        }}
        onCountryChange={(next) => {
          if (next !== undefined) {
            setCountry(next);
          }
        }}
        onBlur={() => {
          onBlur?.();
        }}
        disabled={disabled}
        required={required}
        autoComplete={autoComplete}
        className={invalid ? 'spa-phone__control spa-phone__control--invalid' : 'spa-phone__control'}
        numberInputProps={{ className: 'spa-phone__input' }}
        aria-invalid={invalid ? true : undefined}
        aria-describedby={describedBy === '' ? undefined : describedBy}
        countrySelectComponent={CountryPicker}
        countrySelectProps={
          {
            locale: active,
            flags,
            onPicked: focusNumber,
          } satisfies CountryPickerOwnProps
        }
      />
      {hint === undefined ? null : (
        <p id={hintId} className="spa-field__hint">
          {hint}
        </p>
      )}
      {invalid ? (
        <p id={errorId} className="spa-field__error" role="alert">
          {phoneInvalidMessage(inputValue ?? '', country, active)}
        </p>
      ) : null}
    </div>
  );
}

function countryOf(value: string | undefined): CountryCode | undefined {
  return value === undefined ? undefined : parsePhoneNumberFromString(value)?.country;
}

/**
 * Les libellés que la bibliothèque attend — un nom par pays, dans la langue de
 * l'écran — calculés une fois par langue.
 *
 * Tirés d'`Intl.DisplayNames` plutôt que des fichiers `locale/*.json` de la
 * bibliothèque : le moteur les connaît déjà, dans toutes les langues, et ne
 * coûte rien à télécharger.
 */
const LABELS = new Map<PhoneLocale, Labels>();

function phoneLabels(locale: PhoneLocale): Labels {
  let labels = LABELS.get(locale);

  if (labels === undefined) {
    const built: Labels = { country: TEXTS[locale].country };

    for (const code of getCountries()) {
      built[code] = countryName(code, locale);
    }

    labels = built;
    LABELS.set(locale, labels);
  }

  return labels;
}

/**
 * Les drapeaux, chargés une fois pour toute la page et après son affichage.
 *
 * Un module et non un état par champ : le back-office monte parfois deux
 * champs téléphone à la suite, et le second ne doit pas relancer le
 * téléchargement du premier.
 */
let flagsLoaded: Flags | null = null;
let flagsLoading: Promise<Flags> | null = null;

function loadFlags(): Promise<Flags> {
  flagsLoading ??= import('react-phone-number-input/flags').then((module) => {
    flagsLoaded = module.default;

    return module.default;
  });

  return flagsLoading;
}

function useFlags(): Flags | null {
  const [flags, setFlags] = useState<Flags | null>(flagsLoaded);

  useEffect(() => {
    if (flags !== null) {
      return undefined;
    }

    let live = true;

    loadFlags().then(
      (loaded) => {
        if (live) {
          setFlags(loaded);
        }
      },
      // Un drapeau qui ne charge pas n'empêche pas de saisir un numéro :
      // l'aplat reste, et l'indicatif écrit à côté dit toujours le pays.
      () => undefined,
    );

    return () => {
      live = false;
    };
  }, [flags]);

  return flags;
}

function PhoneFlag({ country, flags }: { readonly country: CountryCode; readonly flags: Flags | null }) {
  const Flag = flags?.[country];

  return (
    <span className="spa-phone__flag" aria-hidden="true">
      {Flag === undefined ? null : <Flag title="" />}
    </span>
  );
}

interface CountryOption {
  readonly value?: CountryCode | undefined;
  readonly label: string;
  readonly divider?: boolean | undefined;
}

/** Ce que `PhoneField` fait passer par `countrySelectProps`. */
interface CountryPickerOwnProps {
  readonly locale: PhoneLocale;
  readonly flags: Flags | null;
  /** Le pays vient d'être choisi, et le panneau de se refermer. */
  readonly onPicked: () => void;
}

/** Ce que la bibliothèque passe à son `countrySelectComponent`. */
interface CountryPickerProps extends CountryPickerOwnProps {
  readonly value?: CountryCode | undefined;
  readonly options: readonly CountryOption[];
  readonly onChange: (country?: CountryCode) => void;
  readonly onFocus?: ((event: FocusEvent<HTMLElement>) => void) | undefined;
  readonly onBlur?: ((event: FocusEvent<HTMLElement>) => void) | undefined;
  readonly disabled?: boolean | undefined;
  readonly readOnly?: boolean | undefined;
}

interface PickerEntry {
  readonly code: CountryCode;
  readonly label: string;
  readonly dial: string;
  /** Dernière entrée du groupe « pays de l'établissement » : un trait la suit. */
  readonly endsSuggestions: boolean;
}

/**
 * Le sélecteur de pays — un bouton, puis un `Sheet` qui porte une recherche et
 * la liste (motif ARIA « combobox » à liste, focus gardé dans la recherche).
 *
 * Le `Sheet` plutôt qu'un menu déroulant accroché au champ : il monte du bas
 * sur un téléphone, là où le pouce l'attend, et le `<dialog>` qui le porte
 * donne le piège de focus, Échap, l'inertie du fond et le calque supérieur —
 * un menu positionné à la main serait rogné par le tiroir du planning, dont le
 * défilement est justement ce qui le fait tenir à 360 px.
 */
function CountryPicker({
  value,
  options,
  onChange,
  onFocus,
  onBlur,
  disabled = false,
  readOnly = false,
  locale,
  flags,
  onPicked,
}: CountryPickerProps) {
  const texts = TEXTS[locale];
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState<CountryCode | null>(null);
  const picked = useRef(false);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const baseId = useId();
  const searchId = `${baseId}-search`;
  const listId = `${baseId}-list`;
  const optionId = (code: CountryCode): string => `${baseId}-${code}`;

  const entries = useMemo(() => pickerEntries(options), [options]);
  const visible = useMemo(() => filterEntries(entries, query, locale), [entries, query, locale]);

  const current = value ?? entries[0]?.code;
  const currentLabel =
    current === undefined ? texts.country : texts.trigger(countryName(current, locale), dialCode(current));

  useEffect(() => {
    if (open) {
      searchRef.current?.focus();
    } else if (picked.current) {
      picked.current = false;
      onPicked();
    }
  }, [open, onPicked]);

  // L'option active reste visible — à l'ouverture, où c'est le pays déjà
  // choisi, comme quand on la déplace au clavier.
  useEffect(() => {
    if (!open || active === null) {
      return;
    }

    const element = document.getElementById(`${baseId}-${active}`);

    if (element !== null && typeof element.scrollIntoView === 'function') {
      element.scrollIntoView({ block: 'nearest' });
    }
  }, [open, active, baseId]);

  const openPicker = (): void => {
    setQuery('');
    setActive(value ?? entries[0]?.code ?? null);
    setOpen(true);
  };

  const close = (): void => {
    setOpen(false);
    setQuery('');
  };

  const choose = (code: CountryCode): void => {
    picked.current = true;
    close();
    onChange(code);
  };

  const move = (offset: number): void => {
    if (visible.length === 0) {
      return;
    }

    const index = visible.findIndex((entry) => entry.code === active);
    const next = index === -1 ? 0 : Math.min(Math.max(index + offset, 0), visible.length - 1);

    setActive(visible[next]?.code ?? null);
  };

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        move(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        move(-1);
        break;
      case 'PageDown':
        event.preventDefault();
        move(8);
        break;
      case 'PageUp':
        event.preventDefault();
        move(-8);
        break;
      case 'Enter':
        // Toujours retenue : ce champ vit **dans** le formulaire qui porte le
        // téléphone, et Entrée le soumettrait au lieu de choisir le pays.
        event.preventDefault();
        if (active !== null && visible.some((entry) => entry.code === active)) {
          choose(active);
        }
        break;
      default:
        break;
    }
  };

  const activeVisible = active !== null && visible.some((entry) => entry.code === active);

  return (
    <>
      <button
        type="button"
        className="spa-phone__country"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={currentLabel}
        disabled={disabled || readOnly}
        onClick={openPicker}
        onFocus={onFocus}
        onBlur={onBlur}
      >
        {current === undefined ? null : (
          <>
            <PhoneFlag country={current} flags={flags} />
            <span className="spa-phone__dial" aria-hidden="true">
              {dialCode(current)}
            </span>
          </>
        )}
        <Icon name="chevron-down" className="spa-phone__chevron" />
      </button>
      <Sheet open={open} onClose={close} title={texts.sheetTitle}>
        {/* La liste n'est rendue qu'ouverte : deux cent quarante options
            montées sous chaque champ téléphone, pour un panneau que la plupart
            des visiteurs n'ouvriront jamais, alourdiraient la page pour rien. */}
        {open ? (
          <div className="spa-phone-picker">
            <div className="spa-field spa-phone-picker__search">
              <label className="spa-field__label" htmlFor={searchId}>
                {texts.search}
              </label>
              <input
                ref={searchRef}
                id={searchId}
                className="spa-field__control"
                type="text"
                role="combobox"
                aria-expanded="true"
                aria-controls={listId}
                aria-autocomplete="list"
                aria-activedescendant={activeVisible ? optionId(active) : undefined}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                enterKeyHint="search"
                placeholder={texts.searchPlaceholder}
                value={query}
                onChange={(event) => {
                  const next = event.target.value;
                  setQuery(next);
                  setActive(filterEntries(entries, next, locale)[0]?.code ?? null);
                }}
                onKeyDown={onSearchKeyDown}
              />
            </div>
            <p className="spa-visually-hidden" role="status">
              {query.trim() === '' ? '' : texts.results(visible.length)}
            </p>
            {visible.length === 0 ? (
              <p className="spa-phone-picker__empty">{texts.noMatch(query.trim())}</p>
            ) : (
              <div id={listId} role="listbox" aria-label={texts.list} className="spa-phone-picker__list">
                {visible.map((entry) => {
                  const selected = entry.code === value;
                  const classes = ['spa-phone-picker__option'];

                  if (entry.code === active) {
                    classes.push('spa-phone-picker__option--active');
                  }

                  if (entry.endsSuggestions && query.trim() === '') {
                    classes.push('spa-phone-picker__option--divider');
                  }

                  return (
                    <div
                      key={entry.code}
                      id={optionId(entry.code)}
                      role="option"
                      aria-selected={selected}
                      className={classes.join(' ')}
                      // Le focus reste dans la recherche : un clic ne doit pas
                      // le lui retirer avant que le choix soit fait.
                      onMouseDown={(event) => {
                        event.preventDefault();
                      }}
                      onMouseMove={() => {
                        if (active !== entry.code) {
                          setActive(entry.code);
                        }
                      }}
                      onClick={() => {
                        choose(entry.code);
                      }}
                    >
                      <PhoneFlag country={entry.code} flags={flags} />
                      <span className="spa-phone-picker__name">{entry.label}</span>
                      <span className="spa-phone-picker__dial">{entry.dial}</span>
                      {selected ? <Icon name="check" className="spa-phone-picker__check" /> : null}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ) : null}
      </Sheet>
    </>
  );
}

/**
 * Les options de la bibliothèque, dans son ordre — le pays de l'établissement,
 * un séparateur, puis les autres —, ramenées à ce que la liste affiche.
 */
function pickerEntries(options: readonly CountryOption[]): readonly PickerEntry[] {
  const entries: PickerEntry[] = [];
  const dividerAt = options.findIndex((option) => option.divider === true);

  options.forEach((option, index) => {
    if (option.divider === true || option.value === undefined) {
      return;
    }

    entries.push({
      code: option.value,
      label: option.label,
      dial: dialCode(option.value),
      endsSuggestions: index === dividerAt - 1,
    });
  });

  return entries;
}

/** Sans accents ni casse : « etats » trouve « États-Unis ». */
function searchKey(text: string): string {
  return text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

/**
 * La liste filtrée par la recherche — nom dans la langue de l'écran **ou** en
 * anglais, code ISO, ou indicatif.
 *
 * L'anglais en plus de la langue de l'écran : une cliente qui cherche
 * « Germany » sur un salon francophone cherche bien l'Allemagne. Trois rangs,
 * dans cet ordre : le nom dans la langue de l'écran **commence** par la
 * recherche (ou le code ISO lui est égal) — « fr » met la France devant ; puis
 * le nom anglais la commence ; puis l'un des deux la contient. Sans le rang
 * du milieu, « ca » ferait passer les « Pays-Bas caribéens » (*Caribbean
 * Netherlands*) avant l'Afrique du Sud, pour une raison invisible à l'écran.
 */
function filterEntries(
  entries: readonly PickerEntry[],
  query: string,
  locale: PhoneLocale,
): readonly PickerEntry[] {
  const needle = searchKey(query.trim());

  if (needle === '') {
    return entries;
  }

  if (/^\+?\d+$/.test(needle)) {
    const digits = needle.replace('+', '');

    return entries.filter((entry) => entry.dial.slice(1).startsWith(digits));
  }

  const ranks: [PickerEntry[], PickerEntry[], PickerEntry[]] = [[], [], []];

  for (const entry of entries) {
    const local = searchKey(entry.label);
    const english = locale === 'en' ? local : searchKey(countryName(entry.code, 'en'));

    if (entry.code.toLowerCase() === needle || local.startsWith(needle)) {
      ranks[0].push(entry);
    } else if (english.startsWith(needle)) {
      ranks[1].push(entry);
    } else if (local.includes(needle) || english.includes(needle)) {
      ranks[2].push(entry);
    }
  }

  return ranks.flat();
}
