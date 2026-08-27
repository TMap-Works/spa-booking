#!/usr/bin/env python3
"""Tests du serveur MCP de recette — `scripts/mcp/recette_server.py`.

    python -m unittest discover -s scripts/tests    # depuis la racine du dépôt
    npm run test:scripts                            # le même, par npm

Ce harnais existe pour #288. Le serveur est le seul morceau du dispositif que
personne ne relit à l'exécution : quand la phase 4bis de `/ticket` s'appuie sur
lui, un périmètre faux ne se voit pas — il se traduit par une recette qui passe
sur des routes qui n'existent pas, ou qui manque celle que le ticket vient
d'écrire. Ce qui est vérifié ici :

1. `DialogueMcp` — le dialogue JSON-RPC tient : `initialize` rend la version du
   client, `tools/list` les huit outils, `tools/call` un contenu textuel, une
   notification ne rend rien, une méthode inconnue rend -32601. Et **rien
   d'autre que du JSON** n'atteint stdout, faute de quoi le client décroche ;
2. `ExtractionDesRoutes` — les décorateurs de Nest tels que ce dépôt les écrit :
   `@Controller({ path, version })`, décorateur multiligne, `@HttpCode`,
   `@Auth`/`@AuthAtLeast`, et surtout un `@Auth()` **cité dans un commentaire**,
   qui a réellement fait passer une route ouverte pour une route gardée ;
3. `PerimetreDuDiff` — le verdict de saut par nature de fichier, et le fait
   qu'un service modifié se recette par les contrôleurs qui le citent, pas par
   tous ceux de son module ;
4. `MasquageDesSorties` — aucun jeton, mot de passe ou secret d'environnement ne
   franchit la frontière du serveur ;
5. `AllocationDesPorts` — deux agents d'une même vague obtiennent deux ports.

Aucune dépendance : `unittest` de la bibliothèque standard, comme les autres
harnais de `scripts/tests`.
"""
import json
import socket
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

# `scripts/mcp/` n'est pas un paquet : c'est un dossier d'exécutables.
sys.path.insert(0, str(ROOT / "scripts" / "mcp"))

import recette_server as rs  # noqa: E402 — l'insertion de chemin la précède


# Un contrôleur qui concentre toutes les formes que le dépôt emploie — et le
# piège du commentaire, qui n'est pas hypothétique : `public-services.controller.ts`
# documente « Aucun `@Auth()` : ces routes sont ouvertes ».
CONTROLEUR = """
import { Controller, Get, Post, Patch, Delete, HttpCode, HttpStatus } from '@nestjs/common';

/**
 * Catalogue de démonstration.
 *
 * Aucun `@Auth()` sur la liste : cette route est ouverte, et ce qui la rend sûre
 * est le DTO qu'elle rend, pas une garde.
 */
@ApiTags('demo')
@Controller({ path: 'demo', version: '1' })
export class DemoController {
  public constructor(private readonly demo: DemoService) {}

  @Get()
  @ApiOperation({
    summary: 'Lister (tout) le catalogue',
    description: 'Une description à virgules, parenthèses (ici) et apostrophes.',
  })
  public async list(): Promise<DemoDto[]> {
    return this.demo.list();
  }

  @Post()
  @Auth('MANAGER', 'ADMIN')
  @HttpCode(HttpStatus.CREATED)
  public async create(@Body() body: CreateDemoDto): Promise<DemoDto> {
    return this.demo.create(body);
  }

  @Patch(':id')
  @AuthAtLeast('STAFF')
  public async update(@Param('id') id: string): Promise<DemoDto> {
    return this.demo.update(id);
  }

  @Delete(':id')
  @Auth('ADMIN')
  @HttpCode(HttpStatus.NO_CONTENT)
  public async remove(@Param('id') id: string): Promise<void> {
    await this.demo.remove(id);
  }
}
"""

CONTROLEUR_NEUTRE = """
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  @Get()
  public async check(): Promise<HealthReport> {
    return this.health.report();
  }
}
"""


def dialogue(messages, delai=90):
    """Fait parler le serveur par son transport réel — un sous-processus, stdio."""
    entree = "".join(json.dumps(m, ensure_ascii=False) + "\n" for m in messages)
    sortie = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "mcp" / "recette_server.py")],
        input=entree,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=delai,
        cwd=str(ROOT),
    )
    reponses = []
    for ligne in (sortie.stdout or "").splitlines():
        if ligne.strip():
            reponses.append(json.loads(ligne))
    return reponses, sortie


class DialogueMcp(unittest.TestCase):
    """Le protocole, joué sur le transport réel plutôt que sur `dispatch` seul."""

    @classmethod
    def setUpClass(cls):
        cls.reponses, cls.sortie = dialogue(
            [
                {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "initialize",
                    "params": {
                        "protocolVersion": "2025-06-18",
                        "capabilities": {},
                        "clientInfo": {"name": "harnais", "version": "1"},
                    },
                },
                {"jsonrpc": "2.0", "method": "notifications/initialized"},
                {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
                {"jsonrpc": "2.0", "id": 3, "method": "tools/call",
                 "params": {"name": "rapport", "arguments": {}}},
                {"jsonrpc": "2.0", "id": 4, "method": "outils/inexistant"},
            ]
        )

    def par_id(self, identifiant):
        return next(r for r in self.reponses if r.get("id") == identifiant)

    def test_initialize_rend_la_version_du_client(self):
        resultat = self.par_id(1)["result"]
        self.assertEqual(resultat["protocolVersion"], "2025-06-18")
        self.assertEqual(resultat["serverInfo"]["name"], "recette")
        self.assertIn("tools", resultat["capabilities"])

    def test_la_notification_ne_rend_rien(self):
        # Cinq messages, dont une notification : quatre réponses attendues.
        self.assertEqual(len(self.reponses), 4)

    def test_les_huit_outils_sont_declares(self):
        noms = [outil["name"] for outil in self.par_id(2)["result"]["tools"]]
        self.assertEqual(
            noms,
            ["perimetre", "api_demarrer", "api_jeu_dessai", "api_openapi",
             "api_appel", "web_demarrer", "arreter", "rapport"],
        )

    def test_chaque_outil_a_un_schema_objet(self):
        for outil in self.par_id(2)["result"]["tools"]:
            with self.subTest(outil=outil["name"]):
                self.assertEqual(outil["inputSchema"]["type"], "object")
                self.assertTrue(outil["description"].strip())

    def test_tools_call_rend_du_contenu_textuel(self):
        resultat = self.par_id(3)["result"]
        self.assertFalse(resultat["isError"])
        self.assertEqual(resultat["content"][0]["type"], "text")
        json.loads(resultat["content"][0]["text"])  # doit être du JSON lisible

    def test_methode_inconnue_rend_une_erreur_de_protocole(self):
        self.assertEqual(self.par_id(4)["error"]["code"], -32601)

    def test_stdout_ne_porte_que_du_json(self):
        # Une seule ligne de diagnostic sur stdout et le client décroche : c'est
        # la panne la plus coûteuse à diagnostiquer d'un serveur MCP.
        for ligne in (self.sortie.stdout or "").splitlines():
            if ligne.strip():
                json.loads(ligne)


class OutilInconnu(unittest.TestCase):
    def test_un_outil_inconnu_ne_tue_pas_le_serveur(self):
        texte, en_erreur = rs.appeler_outil("inexistant", {})
        self.assertTrue(en_erreur)
        self.assertIn("inexistant", texte)

    def test_un_outil_qui_leve_rend_une_erreur_lisible(self):
        rs.INDEX_OUTILS["cobaye"] = {"fonction": lambda args: 1 / 0}
        try:
            texte, en_erreur = rs.appeler_outil("cobaye", {})
        finally:
            del rs.INDEX_OUTILS["cobaye"]
        self.assertTrue(en_erreur)
        self.assertIn("ZeroDivisionError", texte)


class ExtractionDesRoutes(unittest.TestCase):
    """Les décorateurs Nest, tels que ce dépôt les écrit."""

    @classmethod
    def setUpClass(cls):
        cls.routes = {
            (r["methode"], r["chemin"]): r
            for r in rs.extraire_routes(CONTROLEUR, "demo.controller.ts")
        }

    def test_les_quatre_routes_sont_vues(self):
        self.assertEqual(
            sorted(self.routes),
            [
                ("DELETE", "/api/v1/demo/:id"),
                ("GET", "/api/v1/demo"),
                ("PATCH", "/api/v1/demo/:id"),
                ("POST", "/api/v1/demo"),
            ],
        )

    def test_un_auth_cite_en_commentaire_ne_garde_rien(self):
        # Le cœur du harnais : la route de liste est ouverte, et son commentaire
        # parle de `@Auth()`. Une lecture ligne à ligne la déclarait gardée.
        self.assertIsNone(self.routes[("GET", "/api/v1/demo")]["auth"])

    def test_les_roles_exacts_sont_lus(self):
        self.assertEqual(self.routes[("POST", "/api/v1/demo")]["auth"], ["MANAGER", "ADMIN"])
        self.assertEqual(self.routes[("DELETE", "/api/v1/demo/:id")]["auth"], ["ADMIN"])

    def test_le_seuil_de_role_se_developpe_en_liste(self):
        self.assertEqual(
            self.routes[("PATCH", "/api/v1/demo/:id")]["auth"],
            ["STAFF", "MANAGER", "ADMIN"],
        )

    def test_le_statut_attendu_suit_httpcode_puis_le_verbe(self):
        self.assertEqual(self.routes[("POST", "/api/v1/demo")]["statut_attendu"], 201)
        self.assertEqual(self.routes[("DELETE", "/api/v1/demo/:id")]["statut_attendu"], 204)
        self.assertEqual(self.routes[("GET", "/api/v1/demo")]["statut_attendu"], 200)

    def test_un_decorateur_multiligne_ne_decale_pas_la_lecture(self):
        # `@ApiOperation({ summary: …, description: … })` sépare `@Get()` de la
        # signature : le nom du gestionnaire doit rester juste.
        self.assertEqual(self.routes[("GET", "/api/v1/demo")]["handler"], "list")

    def test_version_neutre_et_exclusion_de_prefixe(self):
        routes = rs.extraire_routes(CONTROLEUR_NEUTRE, "health.controller.ts")
        self.assertEqual([r["chemin"] for r in routes], ["/health"])

    def test_un_fichier_sans_controleur_ne_rend_rien(self):
        self.assertEqual(rs.extraire_routes("export const x = 1;", "x.ts"), [])


class PerimetreDuDiff(unittest.TestCase):
    """Le verdict de saut, nature de fichier par nature de fichier."""

    def perimetre(self, *fichiers):
        return rs.calculer_perimetre(fichiers=list(fichiers))

    def test_outillage_infra_docs_et_contrats_se_sautent(self):
        for chemin in (
            "scripts/milestone_run.py",
            ".claude/commands/ticket.md",
            "infra/terraform/modules/network/main.tf",
            "docs/adr/0005-recette-mcp.md",
            ".github/workflows/ci.yml",
            "packages/shared/src/dto/service.ts",
            "apps/api/prisma/migrations/20260101_x/migration.sql",
            "apps/api/test/catalog.integration-spec.ts",
        ):
            with self.subTest(chemin=chemin):
                verdict = self.perimetre(chemin)
                self.assertTrue(verdict["saut"], verdict["raison"])
                self.assertTrue(verdict["raison"])

    def test_un_controleur_touche_ne_se_saute_pas(self):
        verdict = self.perimetre("apps/api/src/modules/catalog/services.controller.ts")
        self.assertFalse(verdict["saut"])
        chemins = {r["chemin"] for r in verdict["api"]["routes"]}
        self.assertIn("/api/v1/services", chemins)

    def test_un_service_se_recette_par_les_controleurs_qui_le_citent(self):
        # `services.service.ts` ne doit pas embarquer les catégories de services,
        # qui vivent dans le même module mais ne le citent pas.
        verdict = self.perimetre("apps/api/src/modules/catalog/services.service.ts")
        chemins = {r["chemin"] for r in verdict["api"]["routes"]}
        self.assertIn("/api/v1/services", chemins)
        self.assertNotIn("/api/v1/service-categories", chemins)

    def test_une_page_next_donne_son_url_sans_groupe_de_routes(self):
        verdict = self.perimetre("apps/web/app/(booking)/salon/[slug]/page.tsx")
        self.assertFalse(verdict["saut"])
        self.assertEqual(verdict["web"]["cibles"][0]["url"], "/salon/[slug]")

    def test_une_maquette_donne_son_url_servie(self):
        verdict = self.perimetre("apps/web/mockups/admin/calendrier.html")
        self.assertEqual(verdict["web"]["cibles"][0]["url"], "/mockups/admin/calendrier.html")

    def test_un_diff_vide_se_saute(self):
        verdict = self.perimetre()
        self.assertTrue(verdict["saut"])

    def test_le_rappel_de_bornage_accompagne_toujours_le_verdict(self):
        verdict = self.perimetre("apps/api/src/modules/catalog/services.controller.ts")
        self.assertIn("Ne recetter que ce qui figure", verdict["rappel"])


class ClassementDesChemins(unittest.TestCase):
    def test_chaque_nature_est_reconnue(self):
        attendu = {
            "apps/api/src/modules/catalog/services.controller.ts": "api:controleur",
            "apps/api/src/modules/catalog/services.service.ts": "api:code",
            "apps/api/src/modules/catalog/__tests__/x.spec.ts": "test",
            "apps/api/prisma/schema.prisma": "migration",
            "apps/web/app/page.tsx": "web:page",
            "apps/web/components/ui/button.tsx": "web:composant",
            "apps/web/mockups/admin/index.html": "web:maquette",
            "apps/web/styles/base.css": "web:style",
            "packages/shared/src/index.ts": "contrats",
            "infra/terraform/main.tf": "infra",
            "scripts/pr_gate.py": "outillage",
            ".claude/settings.json": "outillage",
            "docs/adr/template.md": "docs",
            ".github/workflows/ci.yml": "ci",
            "README.md": "autre",
        }
        for chemin, nature in attendu.items():
            with self.subTest(chemin=chemin):
                self.assertEqual(rs.classer_chemin(chemin), nature)


class MasquageDesSorties(unittest.TestCase):
    """Rien de secret ne franchit la frontière du serveur."""

    JETON = (
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"
        ".eyJzdWIiOiIxMjM0NTY3ODkwIiwidGVuYW50IjoiYSJ9"
        ".dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"
    )

    def test_un_jeton_jwt_disparait(self):
        masque = rs.masquer("Authorization: Bearer %s" % self.JETON)
        self.assertNotIn("eyJ", masque)
        self.assertIn("<jeton masqué>", masque)

    def test_les_champs_sensibles_dun_corps_json_disparaissent(self):
        corps = '{"email":"a@b.test","password":"Recette-2026!","accessToken":"abc"}'
        masque = rs.masquer(corps)
        self.assertNotIn("Recette-2026!", masque)
        self.assertNotIn('"abc"', masque)
        self.assertIn("a@b.test", masque)  # ce qui n'est pas secret reste lisible

    def test_les_valeurs_denvironnement_connues_disparaissent(self):
        # La valeur est **composée** et non écrite en clair : une chaîne longue
        # sous un nom `*_SECRET` est précisément ce que le scan de fuites du
        # dépôt refuse, fût-elle inventée pour un test.
        valeur = "-".join(["cle", "de", "test"] * 4)
        secrets = rs.secrets_de({"JWT_SECRET": valeur, "PORT": "3001"})
        masque = rs.masquer("démarré avec %s" % valeur, secrets)
        self.assertNotIn(valeur, masque)
        self.assertIn("<masqué>", masque)

    def test_un_port_nest_pas_un_secret(self):
        self.assertEqual(rs.secrets_de({"PORT": "3001", "APP_URL": "http://x"}), [])


class PrecedenceDeLEnvironnement(unittest.TestCase):
    """Ce que le processus porte l'emporte sur les fichiers `.env` versionnés.

    C'est l'échappatoire du cas rencontré sur la machine de développement : un
    PostgreSQL natif occupe le 5432 du `docker-compose.yml`, et la recette doit
    pouvoir viser un autre port sans qu'on touche à un fichier versionné.
    """

    def test_une_variable_du_processus_ecrase_le_fichier(self):
        env = rs.charger_env(environnement={"DATABASE_URL": "postgresql://x@127.0.0.1:61162/y"})
        self.assertEqual(env["DATABASE_URL"], "postgresql://x@127.0.0.1:61162/y")

    def test_une_variable_absente_du_processus_garde_la_valeur_du_fichier(self):
        env = rs.charger_env(environnement={})
        self.assertTrue(env["DATABASE_URL"].startswith("postgresql://"))

    def test_une_variable_vide_ne_masque_pas_le_fichier(self):
        env = rs.charger_env(environnement={"DATABASE_URL": ""})
        self.assertTrue(env["DATABASE_URL"].startswith("postgresql://"))


class AllocationDesPorts(unittest.TestCase):
    """Trois agents d'une vague lèvent trois API : elles ne peuvent pas partager un port."""

    def test_un_port_occupe_nest_jamais_rendu(self):
        with socket.socket() as pris:
            pris.bind(("127.0.0.1", 0))
            pris.listen(1)
            occupe = pris.getsockname()[1]
            self.assertFalse(rs.port_disponible(occupe))
            self.assertNotEqual(rs.port_libre(occupe), occupe)

    def test_un_port_libre_prefere_est_rendu_tel_quel(self):
        with socket.socket() as sonde:
            sonde.bind(("127.0.0.1", 0))
            candidat = sonde.getsockname()[1]
        self.assertEqual(rs.port_libre(candidat), candidat)


class AppelsSansApi(unittest.TestCase):
    """Les outils d'appel refusent proprement quand rien n'est démarré."""

    def setUp(self):
        rs.ETAT["api"] = None
        rs.ETAT["jetons"] = {}

    def test_api_appel_sans_api_dit_quoi_faire(self):
        resultat = rs.outil_api_appel({"methode": "GET", "chemin": "/api/v1/services"})
        self.assertIn("api_demarrer", resultat["erreur"])

    def test_un_alias_de_jeton_inconnu_est_nomme(self):
        rs.ETAT["api"] = {"base": "http://127.0.0.1:1", "port": 1}
        try:
            resultat = rs.outil_api_appel(
                {"methode": "GET", "chemin": "/api/v1/services", "jeton": "admin"}
            )
        finally:
            rs.ETAT["api"] = None
        self.assertIn("admin", resultat["erreur"])
        self.assertEqual(resultat["jetons_connus"], [])

    def test_le_rapport_vide_ne_ment_pas(self):
        rs.ETAT["appels"] = []
        rapport = rs.outil_rapport({})
        self.assertEqual(rapport["total"], 0)

    def test_le_rapport_compte_les_echecs(self):
        rs.ETAT["appels"] = [
            {"methode": "GET", "url": "http://x/api/v1/a", "statut": 200, "duree_ms": 5, "conforme": True},
            {"methode": "POST", "url": "http://x/api/v1/b", "statut": 404, "duree_ms": 7, "conforme": False},
        ]
        try:
            rapport = rs.outil_rapport({})
        finally:
            rs.ETAT["appels"] = []
        self.assertEqual(rapport["echecs"], 1)
        self.assertEqual(rapport["verdict"], "rouge")
        self.assertIn("`POST /api/v1/b`", rapport["markdown"])


class DeclarationDesServeurs(unittest.TestCase):
    """`.mcp.json` est ce qui rend le dispositif atteignable — il se vérifie aussi."""

    @classmethod
    def setUpClass(cls):
        cls.config = json.loads((ROOT / ".mcp.json").read_text(encoding="utf-8"))

    def test_les_deux_serveurs_sont_declares(self):
        self.assertEqual(sorted(self.config["mcpServers"]), ["playwright", "recette"])

    def test_aucun_serveur_ne_passe_par_npx(self):
        # Sous Windows, npm et npx sont des .CMD qu'un spawn sans shell ne trouve
        # pas — et les vagues de /milestone tournent sans shell.
        for nom, serveur in self.config["mcpServers"].items():
            with self.subTest(serveur=nom):
                self.assertIn(serveur["command"], ("node", "python"))

    def test_le_serveur_de_recette_pointe_un_fichier_du_depot(self):
        self.assertTrue((ROOT / self.config["mcpServers"]["recette"]["args"][0]).is_file())

    def test_playwright_est_une_dependance_a_version_fixee(self):
        # Ce job de CI n'installe rien (`ci.yml`, job « scripts ») : vérifier la
        # présence de `node_modules` y échouerait toujours. Ce qui se vérifie
        # sans installation, c'est la **déclaration** — et c'est elle qui compte,
        # une version flottante changeant le navigateur au milieu d'un jalon.
        paquet = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
        version = paquet["devDependencies"]["@playwright/mcp"]
        self.assertRegex(version, r"^\d+\.\d+\.\d+$", "version non fixée : %s" % version)
        self.assertTrue(
            self.config["mcpServers"]["playwright"]["args"][0].startswith(
                "node_modules/@playwright/mcp/"
            )
        )


if __name__ == "__main__":
    unittest.main()
