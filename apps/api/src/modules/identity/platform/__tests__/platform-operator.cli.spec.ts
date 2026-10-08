import { parseArguments, parseResetTotpArguments } from '../platform-operator.cli';

describe('platform-operator CLI — arguments', () => {
  describe('parseResetTotpArguments (#1442)', () => {
    it('ne voit pas de réarmement sans --reset-totp', () => {
      expect(
        parseResetTotpArguments(['--email', 'a@b.test', '--first-name', 'A', '--last-name', 'B']),
      ).toBeNull();
    });

    it('lit un drapeau seul, et normalise l’adresse', () => {
      expect(parseResetTotpArguments(['--reset-totp', '--email', ' Operateur@TMAP-works.test '])).toEqual({
        email: 'operateur@tmap-works.test',
      });
    });

    it('ne réarme pas sur --reset-totp=false', () => {
      expect(parseResetTotpArguments(['--reset-totp=false', '--email', 'a@b.test'])).toBeNull();
      expect(parseResetTotpArguments(['--reset-totp=true', '--email', 'a@b.test'])).toEqual({
        email: 'a@b.test',
      });
    });

    it('lit la forme --clé=valeur', () => {
      expect(parseResetTotpArguments(['--reset-totp', '--email=a@b.test'])).toEqual({
        email: 'a@b.test',
      });
    });

    it('exige l’adresse', () => {
      expect(() => parseResetTotpArguments(['--reset-totp'])).toThrow('--email');
    });
  });

  describe('parseArguments', () => {
    it('tient un --password sans valeur pour absent, et tire alors le mot de passe', () => {
      const args = parseArguments([
        '--email',
        'a@b.test',
        '--first-name',
        'A',
        '--last-name',
        'B',
        '--password',
      ]);

      expect(args.password).toBeNull();
    });

    it('nomme une option donnée sans valeur comme manquante', () => {
      expect(() =>
        parseArguments(['--email', '--first-name', 'A', '--last-name', 'B']),
      ).toThrow('--email');
    });
  });
});
