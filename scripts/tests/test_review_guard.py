#!/usr/bin/env python3
"""Tests du garde-fou de revue — `scripts/review_guard.py`.

    python -m unittest discover -s scripts/tests    # depuis la racine du dépôt
    npm run test:scripts                            # le même, par npm

Ce que ces tests protègent (#167). Deux agents ont vu leur revue de phase 5
modifier des fichiers du dépôt principal ; les deux fois, le rattrapage n'a tenu
qu'à la vigilance de l'agent. Le garde-fou remplace cette vigilance — mais un
garde-fou n'a de valeur que s'il tient les deux bouts :

1. **il crie quand il faut** — une modification, une apparition ou une
   suppression dans l'arbre de travail du dépôt principal pendant la fenêtre de
   revue doit faire échouer la phase 5, franchement, en nommant les chemins ;
2. **il se tait quand il faut** — le travail légitime du ticket dans son propre
   worktree, et les écritures ignorées par git (journal de jalon, worktrees
   frères, `node_modules`), ne doivent produire aucun bruit. Un garde-fou qui
   crie pendant une vague de trois agents serait débranché dès le premier run,
   et l'incident reviendrait.

Le second point est le plus fragile des deux, donc le plus testé.

Les tests s'exécutent sur de **vrais dépôts git jetables** avec de **vrais
worktrees liés**, et appellent le script par son interface en ligne de commande :
c'est le contrat exact sur lequel s'appuie la phase 5 de `ticket.md`, codes de
sortie compris. Un double aurait testé autre chose que ce qui tourne.

Aucune dépendance : `unittest` de la bibliothèque standard, comme les autres
harnais de `scripts/tests`.
"""
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "review_guard.py"

OK = 0
DIRTY = 2
NO_SNAPSHOT = 3
USAGE = 4


def _force_remove(func, path, _exc):
    """Sous Windows, git laisse ses objets en lecture seule : rmtree échoue sinon."""
    try:
        os.chmod(path, stat.S_IWRITE)
        func(path)
    except OSError:
        pass


# `shutil.rmtree(onerror=...)` est déprécié depuis 3.12 et retiré en 3.14 ;
# `onexc` prend la même fonction de rappel. Choisir le mot-clé selon la version
# évite que le harnais casse à la première mise à jour de l'interpréteur.
_RMTREE_HOOK = "onexc" if sys.version_info >= (3, 12) else "onerror"


def remove_tree(path):
    shutil.rmtree(path, **{_RMTREE_HOOK: _force_remove})


def git(*args, cwd):
    done = subprocess.run(
        ["git", *args], cwd=str(cwd),
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        encoding="utf-8", errors="replace", check=False,
    )
    if done.returncode != 0:
        raise AssertionError(f"git {' '.join(args)} a échoué :\n{done.stdout}")
    return done.stdout.strip()


class ReviewGuardTest(unittest.TestCase):
    """Un dépôt principal, un worktree lié, et le script appelé depuis l'un ou l'autre."""

    def setUp(self):
        base = Path(tempfile.mkdtemp(prefix="review-guard-")).resolve()
        self.addCleanup(remove_tree, base)
        self.main = base / "depot"
        self.main.mkdir()

        git("init", cwd=self.main)
        git("config", "user.email", "test@example.com", cwd=self.main)
        git("config", "user.name", "Test", cwd=self.main)
        git("config", "commit.gpgsign", "false", cwd=self.main)

        # Un fichier d'orchestration — l'analogue de scripts/milestone_plan.py,
        # que la revue de l'agent #13 a sali — et un .gitignore représentatif.
        (self.main / "orchestration.py").write_text("print('plan')\n", encoding="utf-8")
        (self.main / ".gitignore").write_text(
            "node_modules/\n.claude/.milestone/\n.claude/worktrees/\n", encoding="utf-8")
        git("add", "-A", cwd=self.main)
        git("commit", "-m", "socle", cwd=self.main)

        self.worktree = self.main / ".claude" / "worktrees" / "agent-abc"
        self.worktree.parent.mkdir(parents=True, exist_ok=True)
        git("worktree", "add", "-b", "bugfix/167-essai", str(self.worktree), cwd=self.main)

    def run_guard(self, action, cwd=None):
        done = subprocess.run(
            [sys.executable, str(SCRIPT), action],
            cwd=str(cwd or self.worktree),
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            encoding="utf-8", errors="replace", check=False,
        )
        return done.returncode, done.stdout, done.stderr

    # ------------------------------------------------------------------ crier

    def test_modification_dans_le_depot_principal_fait_echouer(self):
        """Le cas de l'agent #13 : un fichier suivi réécrit pendant la revue."""
        self.assertEqual(self.run_guard("snapshot")[0], OK)
        (self.main / "orchestration.py").write_text("print('CORROMPU')\n", encoding="utf-8")

        code, _out, err = self.run_guard("verify")
        self.assertEqual(code, DIRTY, err)
        # Le constat doit dire *modifié* : un fichier suivi et propre à
        # l'instantané n'était pas dans la liste de `git status`, mais il n'a
        # pas pour autant été créé — et « apparu » appellerait un `clean`
        # destructeur là où il faut un `checkout`.
        self.assertRegex(err, r"modifié\s+orchestration\.py")
        # Le message doit porter la remédiation, pas seulement le constat.
        self.assertIn('checkout HEAD -- "orchestration.py"', err)

    def test_fichier_apparu_dans_le_depot_principal_fait_echouer(self):
        self.assertEqual(self.run_guard("snapshot")[0], OK)
        (self.main / "intrus.py").write_text("x = 1\n", encoding="utf-8")

        code, _out, err = self.run_guard("verify")
        self.assertEqual(code, DIRTY, err)
        self.assertRegex(err, r"apparu\s+intrus\.py")
        # `checkout` ne restaure pas un chemin que git ne suit pas : sur un
        # fichier apparu, la remédiation proposée doit être celle qui le retire.
        self.assertIn("clean -f", err)
        self.assertNotIn("checkout", err)

    def test_fichier_supprime_dans_le_depot_principal_fait_echouer(self):
        self.assertEqual(self.run_guard("snapshot")[0], OK)
        (self.main / "orchestration.py").unlink()

        code, _out, err = self.run_guard("verify")
        self.assertEqual(code, DIRTY, err)
        self.assertRegex(err, r"disparu\s+orchestration\.py")
        self.assertIn('checkout HEAD -- "orchestration.py"', err)

    def test_second_coup_sur_un_fichier_deja_sale_fait_echouer(self):
        """Une salissure préexistante ne doit pas servir de couverture.

        Le dépôt principal peut être déjà sale au moment de l'instantané. Le
        garde-fou compare des *contenus*, pas la seule liste de `git status` :
        sans cela, une revue qui réécrit un fichier déjà modifié passerait
        inaperçue, la ligne de statut étant identique avant et après.
        """
        (self.main / "orchestration.py").write_text("print('local')\n", encoding="utf-8")
        self.assertEqual(self.run_guard("snapshot")[0], OK)
        (self.main / "orchestration.py").write_text("print('revue')\n", encoding="utf-8")

        code, _out, err = self.run_guard("verify")
        self.assertEqual(code, DIRTY, err)
        self.assertRegex(err, r"modifié\s+orchestration\.py")
        # Restaurer emporterait aussi la modification locale préexistante :
        # la remédiation doit le dire plutôt que de la détruire en silence.
        self.assertIn("déjà modifié avant la revue", err)

    def test_verify_sans_instantane_echoue(self):
        """Sauter l'instantané ne doit pas ressembler à un succès."""
        code, _out, err = self.run_guard("verify")
        self.assertEqual(code, NO_SNAPSHOT, err)
        self.assertIn("snapshot", err)

    def _state_file(self):
        common = Path(git("rev-parse", "--git-common-dir", cwd=self.worktree)).resolve()
        found = sorted((common / "spa-review-guard").glob("*.json"))
        self.assertEqual(len(found), 1, f"un seul instantané attendu : {found}")
        return found[0]

    def test_instantane_perime_ne_vaut_pas_instantane(self):
        """Un chemin de worktree réutilisé ne doit pas hériter d'une vieille fenêtre.

        Reprise de jalon, ticket rejoué : le même emplacement peut resservir. Si
        `verify` acceptait l'instantané d'hier, une phase 5 qui aurait sauté
        `snapshot` passerait pour encadrée — exactement le trou que le code de
        sortie `NO_SNAPSHOT` existe pour fermer.
        """
        self.assertEqual(self.run_guard("snapshot")[0], OK)
        state = self._state_file()
        payload = json.loads(state.read_text(encoding="utf-8"))
        payload["created"] = time.time() - 48 * 3600
        state.write_text(json.dumps(payload), encoding="utf-8")

        code, _out, err = self.run_guard("verify")
        self.assertEqual(code, NO_SNAPSHOT, err)
        self.assertIn("périmé", err)

    def test_instantane_illisible_ne_vaut_pas_instantane(self):
        """Un état tronqué se lit comme une absence, pas comme une trace exploitable."""
        self.assertEqual(self.run_guard("snapshot")[0], OK)
        self._state_file().write_text('{"fingerprint": null}', encoding="utf-8")

        code, _out, err = self.run_guard("verify")
        self.assertEqual(code, NO_SNAPSHOT, err)

    def test_instantane_consomme_par_un_verify_propre(self):
        """Une fenêtre close ne doit plus pouvoir en encadrer une autre."""
        self.assertEqual(self.run_guard("snapshot")[0], OK)
        state = self._state_file()
        self.assertEqual(self.run_guard("verify")[0], OK)
        self.assertFalse(state.exists(), "l'instantané aurait dû être consommé")

        code, _out, err = self.run_guard("verify")
        self.assertEqual(code, NO_SNAPSHOT, err)

    # ------------------------------------------------------------- se taire

    def test_travail_dans_le_worktree_ne_declenche_rien(self):
        """Le travail légitime du ticket : le cas nominal, il doit être muet."""
        self.assertEqual(self.run_guard("snapshot")[0], OK)
        (self.worktree / "orchestration.py").write_text("print('corrigé')\n", encoding="utf-8")
        (self.worktree / "nouveau.py").write_text("y = 2\n", encoding="utf-8")
        git("add", "-A", cwd=self.worktree)
        git("commit", "-m", "travail du ticket", cwd=self.worktree)

        code, out, err = self.run_guard("verify")
        self.assertEqual(code, OK, err)
        self.assertIn("aucune écriture", out)

    def test_ecritures_ignorees_par_git_ne_declenchent_rien(self):
        """Journal de jalon et worktrees frères : le bruit d'une vague en cours.

        Tous les agents écrivent en continu dans `.claude/.milestone/` du dépôt
        principal, et les worktrees frères vivent sous `.claude/worktrees/`.
        Les deux sont gitignorés — le garde-fou ne doit pas les voir, sans quoi
        il serait inutilisable pendant une vague.
        """
        self.assertEqual(self.run_guard("snapshot")[0], OK)
        journal = self.main / ".claude" / ".milestone"
        journal.mkdir(parents=True, exist_ok=True)
        (journal / "latest.log").write_text("#167 revue\n", encoding="utf-8")
        frere = self.main / ".claude" / "worktrees" / "agent-def"
        frere.mkdir(parents=True, exist_ok=True)
        (frere / "travail.py").write_text("z = 3\n", encoding="utf-8")
        modules = self.main / "node_modules" / "paquet"
        modules.mkdir(parents=True, exist_ok=True)
        (modules / "index.js").write_text("module.exports = {}\n", encoding="utf-8")

        code, out, err = self.run_guard("verify")
        self.assertEqual(code, OK, err)
        self.assertIn("aucune écriture", out)

    def test_head_qui_bouge_seul_ne_fait_pas_echouer(self):
        """L'orchestrateur récupère entre deux vagues : ce n'est pas une écriture de revue."""
        self.assertEqual(self.run_guard("snapshot")[0], OK)
        (self.main / "autre.py").write_text("a = 1\n", encoding="utf-8")
        git("add", "-A", cwd=self.main)
        git("commit", "-m", "avance de l'orchestrateur", cwd=self.main)

        code, out, err = self.run_guard("verify")
        self.assertEqual(code, OK, err)
        self.assertIn("HEAD", out)

    def test_hors_worktree_le_garde_fou_est_inactif(self):
        """`/ticket --no-worktree` : rien à protéger, et surtout rien à casser."""
        for action in ("snapshot", "verify"):
            code, out, err = self.run_guard(action, cwd=self.main)
            self.assertEqual(code, OK, err)
            self.assertIn("inactif", out)

    # -------------------------------------------------------------- appel

    def test_hors_depot_git_sort_en_erreur_d_appel(self):
        ailleurs = Path(tempfile.mkdtemp(prefix="review-guard-hors-")).resolve()
        self.addCleanup(remove_tree, ailleurs)
        code, _out, err = self.run_guard("verify", cwd=ailleurs)
        self.assertEqual(code, USAGE, err)


if __name__ == "__main__":
    unittest.main()
