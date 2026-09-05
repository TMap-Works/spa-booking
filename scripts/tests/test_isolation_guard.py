#!/usr/bin/env python3
"""Tests du garde-fou d'isolation — `scripts/isolation_guard.py`.

    python -m unittest discover -s scripts/tests    # depuis la racine du dépôt
    npm run test:scripts                            # le même, par npm

Ce que ces tests protègent (#427). L'agent de #414 a été lancé avec
`isolation: "worktree"` et n'a pas reçu de worktree : il a écrit dans l'arbre de
travail du dépôt principal, sorti sur `develop`. Il ne l'a su qu'au
`git worktree list` de la phase 1, et a improvisé la suite — dont le
contournement du `git branch -m` que la phase 1 prescrit, et qui aurait renommé
`develop`.

Un garde-fou qui remplace cette improvisation doit tenir trois bouts :

1. **il crie quand il faut** — dans l'arbre de travail du dépôt principal, la
   barrière sort en `2` et le message nomme l'arbre, sa branche, et les trois
   précautions que #414 a dû retrouver seul ;
2. **il se tait quand il faut** — dans un worktree lié, et sous `--allow-main`
   qui couvre le `/ticket --no-worktree` délibéré. Un garde-fou qui crie pendant
   une vague nominale serait débranché au premier run ;
3. **il tranche la conduite** — refuser de commiter n'a de sens que si d'autres
   agents écrivent dans le même arbre. Le compte des worktrees d'agent vivants
   est ce qui distingue le défaut survivable de la perte de travail garantie.

Les tests s'exécutent sur de **vrais dépôts git jetables** avec de **vrais
worktrees liés**, et appellent le script par son interface en ligne de commande :
c'est le contrat exact sur lequel s'appuie un agent de vague, codes de sortie
compris. Un double aurait testé autre chose que ce qui tourne.

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
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "isolation_guard.py"

OK = 0
NOT_ISOLATED = 2
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


class IsolationGuardTest(unittest.TestCase):
    """Un dépôt principal sur `develop`, et des worktrees liés à la demande."""

    def setUp(self):
        base = Path(tempfile.mkdtemp(prefix="isolation-guard-")).resolve()
        self.addCleanup(remove_tree, base)
        self.main = base / "depot"
        self.main.mkdir()

        git("init", "--initial-branch", "develop", cwd=self.main)
        git("config", "user.email", "test@example.com", cwd=self.main)
        git("config", "user.name", "Test", cwd=self.main)
        git("config", "commit.gpgsign", "false", cwd=self.main)

        (self.main / "orchestration.py").write_text("print('plan')\n", encoding="utf-8")
        (self.main / ".gitignore").write_text(
            "node_modules/\n.claude/.milestone/\n.claude/worktrees/\n", encoding="utf-8")
        git("add", "-A", cwd=self.main)
        git("commit", "-m", "socle", cwd=self.main)

    def add_worktree(self, name, branch):
        """Un worktree lié, rangé comme l'outil `Agent` les range."""
        path = self.main / ".claude" / "worktrees" / name
        path.parent.mkdir(parents=True, exist_ok=True)
        git("worktree", "add", "-b", branch, str(path), cwd=self.main)
        return path

    def run_guard(self, *args, cwd=None):
        done = subprocess.run(
            [sys.executable, str(SCRIPT), *args],
            cwd=str(cwd or self.main),
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            encoding="utf-8", errors="replace", check=False,
        )
        return done.returncode, done.stdout, done.stderr

    # -------------------------------------------------------------- se taire

    def test_un_worktree_lie_passe_la_barriere(self):
        """Le cas nominal d'une vague : ne rien dire, sortir en 0."""
        worktree = self.add_worktree("agent-abc", "bugfix/427-essai")
        code, out, err = self.run_guard("check", cwd=worktree)
        self.assertEqual(code, OK, err)
        self.assertIn("isolation ok", out)
        self.assertIn("agent-abc", out)

    def test_allow_main_couvre_le_no_worktree_delibere(self):
        """`/ticket --no-worktree` travaille dans l'arbre commun exprès : le
        constat reste utile, l'échec ne l'est pas."""
        code, out, err = self.run_guard("check", "--allow-main")
        self.assertEqual(code, OK, err)
        self.assertIn("dépôt principal", out)
        # Même sous `--allow-main`, le piège de la phase 1 doit être rappelé :
        # c'est là que `git branch -m` renommerait `develop`.
        self.assertIn("branch -m", out)

    # --------------------------------------------------------------- crier

    def test_le_depot_principal_fait_echouer_la_barriere(self):
        code, _out, err = self.run_guard("check")
        self.assertEqual(code, NOT_ISOLATED, err)
        self.assertIn("isolation NON obtenue", err)
        self.assertIn("#427", err)

    def test_le_message_nomme_l_arbre_et_sa_branche(self):
        """C'est ce qui permet de vérifier le constat sans le refaire à la main."""
        _code, _out, err = self.run_guard("check")
        self.assertIn(str(self.main), err)
        self.assertIn("develop", err)

    def test_les_trois_precautions_sont_dans_le_message(self):
        """#414 les a retrouvées seul, une à une. Elles ne doivent plus dépendre
        de la perspicacité de l'agent."""
        _code, _out, err = self.run_guard("check")
        self.assertIn("NE JAMAIS `git branch -m`", err)
        self.assertIn("checkout -b", err)
        self.assertIn("review_guard.py", err)
        self.assertIn("develop", err)

    def test_les_fichiers_non_commites_du_depot_principal_sont_nommes(self):
        """L'hypothèse n°1 de #427 porte sur l'arbre sale au lancement de la
        vague : le garde-fou doit la rendre mesurable, pas la supposer."""
        (self.main / "regles.json").write_text("{}\n", encoding="utf-8")
        _code, _out, err = self.run_guard("check")
        self.assertIn("regles.json", err)
        self.assertIn("1 fichier(s)", err)

    def test_les_fichiers_ignores_ne_comptent_pas_comme_sales(self):
        """`node_modules/` et `.claude/.milestone/` sont écrits en permanence par
        tous les agents : les compter ferait crier le garde-fou en continu."""
        (self.main / "node_modules").mkdir()
        (self.main / "node_modules" / "x.js").write_text("x\n", encoding="utf-8")
        _code, _out, err = self.run_guard("check")
        self.assertIn("0 fichier(s)", err)

    # --------------------------------------------------- trancher la conduite

    def test_des_agents_concurrents_imposent_de_refuser_le_commit(self):
        """Le cas qui coûte : trois agents dans un même arbre de travail se
        perdent mutuellement leur travail non commité."""
        self.add_worktree("agent-abc", "bugfix/1-un")
        self.add_worktree("agent-def", "bugfix/2-deux")
        code, _out, err = self.run_guard("check")
        self.assertEqual(code, NOT_ISOLATED, err)
        self.assertIn("REFUSER DE COMMITER", err)
        self.assertIn("agent-abc", err)
        self.assertIn("agent-def", err)
        self.assertIn("blocked", err)

    def test_sans_agent_concurrent_le_defaut_reste_tenable(self):
        """C'est le cas de #414 : largeur 1, un seul arbre, le ticket est allé à
        son terme. Crier « refuser de commiter » ici ferait débrancher le
        garde-fou pour cause de fausse alerte."""
        code, _out, err = self.run_guard("check")
        self.assertEqual(code, NOT_ISOLATED, err)
        self.assertNotIn("REFUSER DE COMMITER", err)
        self.assertIn("poursuivre est tenable", err)

    def test_un_worktree_disparu_n_est_pas_un_agent_concurrent(self):
        """L'entrée survit à son répertoire jusqu'au prochain `git worktree
        prune`, que `worktree_gc.py` ne lance qu'en fin de vague. La compter
        ferait refuser un commit au nom d'un agent qui n'est plus là."""
        parti = self.add_worktree("agent-abc", "bugfix/1-un")
        remove_tree(parti)
        code, _out, err = self.run_guard("check")
        self.assertEqual(code, NOT_ISOLATED, err)
        self.assertNotIn("REFUSER DE COMMITER", err)
        self.assertIn("poursuivre est tenable", err)

    def test_un_worktree_humain_n_est_pas_un_agent_concurrent(self):
        """Un worktree ouvert à la main n'est pas un agent de vague : le compter
        ferait refuser un commit que rien ne menace."""
        self.add_worktree("relecture-locale", "chore/3-trois")
        code, _out, err = self.run_guard("check")
        self.assertEqual(code, NOT_ISOLATED, err)
        self.assertNotIn("REFUSER DE COMMITER", err)

    def test_le_propre_worktree_de_l_agent_ne_se_compte_pas(self):
        """Appelé depuis son worktree, l'agent ne doit pas se voir lui-même dans
        la liste des concurrents — mais bien voir ses voisins."""
        mine = self.add_worktree("agent-abc", "bugfix/1-un")
        self.add_worktree("agent-def", "bugfix/2-deux")
        _code, out, _err = self.run_guard("report", cwd=mine)
        self.assertIn("agents concurrents  1", out)
        self.assertIn("agent-def", out)

    # ------------------------------------------------------------- le détail

    def test_report_decrit_l_etat_sans_faire_echouer(self):
        """`report` diagnostique ; c'est `check` qui barre la route."""
        (self.main / "regles.json").write_text("{}\n", encoding="utf-8")
        code, out, err = self.run_guard("report")
        self.assertEqual(code, OK, err)
        self.assertIn("isolation NON obtenue", out)
        self.assertIn("regles.json", out)

    def test_la_branche_garde_son_type(self):
        """`refs/heads/bugfix/427-…` ne se découpe pas sur le dernier « / » :
        amputée de son type, la branche que le message donne n'est plus celle
        qu'on peut copier-coller."""
        worktree = self.add_worktree("agent-abc", "bugfix/427-agent-sans-worktree")
        _code, out, _err = self.run_guard("report", cwd=worktree)
        self.assertIn("bugfix/427-agent-sans-worktree", out)

    def test_json_rend_l_etat_et_garde_le_verdict(self):
        """`--json` change la forme, pas la barrière : un appelant programmatique
        qui ne lirait que le code de sortie doit voir le même échec."""
        code, out, err = self.run_guard("check", "--json")
        self.assertEqual(code, NOT_ISOLATED, err)
        state = json.loads(out)
        self.assertFalse(state["isolated"])
        self.assertEqual(state["main_branch"], "develop")
        self.assertEqual(Path(state["main"]), self.main)

    def test_hors_depot_git_sort_en_erreur_d_environnement(self):
        """Ni « isolé » ni « pas isolé » : l'appel n'a pas eu lieu. Rendre 0 ici
        ferait passer une absence de réponse pour une réponse rassurante."""
        ailleurs = Path(tempfile.mkdtemp(prefix="hors-depot-"))
        self.addCleanup(remove_tree, ailleurs)
        code, _out, err = self.run_guard("check", cwd=ailleurs)
        self.assertEqual(code, USAGE, err)
        self.assertIn("ÉCHEC", err)

    def test_check_est_l_action_par_defaut(self):
        """La barrière doit être ce qu'on obtient sans y penser."""
        code, _out, _err = self.run_guard()
        self.assertEqual(code, NOT_ISOLATED)


if __name__ == "__main__":
    unittest.main()
