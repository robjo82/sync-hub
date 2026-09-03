#!/usr/bin/env python3
"""Publie la rubrique « Sync-hub » dans le module Connaissances de www.ekonum.fr.

Simulation par défaut, comme tout script qui touche à une base : il imprime ce qu'il ferait et
s'arrête. Relancer avec APPLY=1 pour écrire.

    python3 docs/tuto-connaissances/publier.py          # simulation
    APPLY=1 python3 docs/tuto-connaissances/publier.py   # écriture

La clé n'est jamais saisie, ni affichée, ni stockée ici : elle est injectée à l'exécution par le
broker Ekonum, qui la lit dans Bitwarden et la pose dans l'environnement du processus.

    EKONUM_IDENTITY=claude ekonum-secret run \
      --secret ODOO_KEY="Ekonum - API Odoo#Clé API" \
      -- python3 docs/tuto-connaissances/publier.py

C'est la règle qui prime : un agent utilise un secret sans jamais le voir. Une clé affichée une
fois finit dans l'historique de conversation, que sync-hub archive verbatim puis réplique sur le
hub — donc une clé affichée est une clé à changer.

Idempotent : un article déjà présent sous le même titre est mis à jour, pas dupliqué.
"""
import base64
import os
import sys
import urllib.request
import json
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import contenu  # noqa: E402

HOST = 'https://www.ekonum.fr'
RACINE = 'Sync-hub'
IMAGES = Path(__file__).parent / 'images'
APPLY = os.environ.get('APPLY') == '1'


def api_key() -> str:
    """La clé, telle que le broker l'a posée dans l'environnement. Aucun repli : un repli sur le
    trousseau inviterait à y recopier la clé à la main, c'est-à-dire à la faire transiter par un
    terminal et donc par l'historique."""
    key = os.environ.get('ODOO_KEY')
    if not key:
        sys.exit(
            "ODOO_KEY absente. Lancer via le broker, qui injecte la clé sans l'afficher :\n"
            "  EKONUM_IDENTITY=claude ekonum-secret run \\\n"
            "    --secret ODOO_KEY=\"Ekonum - API Odoo#Clé API\" \\\n"
            "    -- python3 docs/tuto-connaissances/publier.py"
        )
    return key


KEY = api_key()


def call(model: str, method: str, **kwargs):
    req = urllib.request.Request(
        f'{HOST}/json/2/{model}/{method}',
        data=json.dumps(kwargs).encode(),
        headers={'Content-Type': 'application/json', 'Authorization': f'Bearer {KEY}'},
    )
    with urllib.request.urlopen(req, timeout=120) as res:
        return json.loads(res.read())


def article_id(titre: str, parent: int | None) -> int | None:
    domain = [['name', '=', titre]]
    domain.append(['parent_id', '=', parent] if parent else ['parent_id', '=', False])
    found = call('knowledge.article', 'search_read', domain=domain, fields=['id'], limit=1)
    return found[0]['id'] if found else None


def upsert(titre: str, corps: str, parent: int | None, sequence: int) -> int:
    existing = article_id(titre, parent)
    vals = {'name': titre, 'body': corps, 'sequence': sequence,
            # Interne : ces captures montrent des noms de projets clients. Un article en visibilité
            # portail les exposerait aux clients eux-mêmes.
            'internal_permission': 'write', 'is_article_visible_by_everyone': False}
    if parent:
        vals['parent_id'] = parent

    if existing:
        print(f'    mise à jour  « {titre} » (id {existing})')
        if APPLY:
            call('knowledge.article', 'write', ids=[existing], vals=vals)
        return existing

    print(f'    création     « {titre} »')
    if not APPLY:
        return -abs(hash(titre)) % 10**6  # identifiant fictif pour la suite de la simulation
    return call('knowledge.article', 'create', vals_list=[vals])[0]


def televerser_images(article: int) -> dict[str, str]:
    """Attache les captures à l'article racine et renvoie leurs URL publiques."""
    urls: dict[str, str] = {}
    for chemin in sorted(IMAGES.glob('*.png')):
        existing = call('ir.attachment', 'search_read',
                        domain=[['name', '=', chemin.name], ['res_model', '=', 'knowledge.article']],
                        fields=['id', 'access_token'], limit=1)
        if existing and existing[0].get('access_token'):
            att = existing[0]
            print(f'    déjà en place {chemin.name}')
        elif not APPLY:
            print(f'    téléversera   {chemin.name} ({chemin.stat().st_size // 1024} ko)')
            urls[chemin.name] = f'{HOST}/web/image/0?access_token=SIMULATION'
            continue
        else:
            print(f'    téléversement {chemin.name} ({chemin.stat().st_size // 1024} ko)')
            # `raw`, pas `datas` : sur Odoo SaaS 19.3, l'API JSON-2 rejette `datas`
            # (« Invalid field 'datas' in 'ir.attachment' ») — et pire, un `create` qui le
            # contient est accepté sans erreur mais l'ignore. On obtient des pièces jointes de
            # 0 octet, dont /web/image sert un substitut de 6 078 octets en HTTP 200 : un
            # tutoriel sans images qui n'a l'air cassé nulle part.
            new_id = call('ir.attachment', 'create', vals_list=[{
                'name': chemin.name, 'res_model': 'knowledge.article', 'res_id': article,
                'mimetype': 'image/png', 'public': True,
                'raw': base64.b64encode(chemin.read_bytes()).decode(),
            }])[0]
            call('ir.attachment', 'generate_access_token', ids=[new_id])
            att = call('ir.attachment', 'read', ids=[new_id], fields=['id', 'access_token', 'file_size'])[0]
            if not att.get('file_size'):
                sys.exit(f"    {chemin.name} : pièce jointe créée vide (file_size=0), arrêt.")
        urls[chemin.name] = f"{HOST}/web/image/{att['id']}?access_token={att['access_token']}"
    return urls


def main() -> None:
    print(f'\n  Rubrique « {RACINE} » sur {HOST}')
    print(f'  Mode : {"ÉCRITURE" if APPLY else "SIMULATION"}\n')

    racine = upsert(RACINE, contenu.ACCUEIL, None, 1)

    print('\n  Captures :')
    img = televerser_images(racine)

    print('\n  Articles :')
    pages = [
        ('Sync-hub en deux minutes', contenu.deux_minutes(img)),
        ('Installer sync-hub sur son poste', contenu.installation(img)),
        ("Retrouver les échanges d'un sujet", contenu.recherche(img)),
        ('Classer ses conversations par projet', contenu.projets(img)),
        ('Organiser les projets en catégories', contenu.categories(img)),
        ('Suivre son temps et ses coûts', contenu.temps_couts(img)),
    ]
    for index, (titre, corps) in enumerate(pages, start=1):
        upsert(titre, corps, racine, index)

    if not APPLY:
        print('\n  (simulation — rien n\'a été écrit ; relancer avec APPLY=1)\n')
        return

    # Compter après, comme pour toute opération de masse.
    total = call('knowledge.article', 'search_count',
                 domain=['|', ['id', '=', racine], ['parent_id', '=', racine]])
    print(f'\n  {total} articles en place sous « {RACINE} ».')
    print(f'  {HOST}/odoo/knowledge/{racine}\n')


if __name__ == '__main__':
    main()
