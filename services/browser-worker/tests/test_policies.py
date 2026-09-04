"""Politiques : intentions, domaines, protections humaines."""

from __future__ import annotations

import pytest

from app.models import Intent
from app.policies import (
    DomainBlocked,
    DomainPolicy,
    build_prompt,
    excluded_actions,
    needs_human_intervention,
    verify_action_names,
)


class TestIntentRestrictions:
    def test_read_cannot_click_or_type(self) -> None:
        excluded = excluded_actions(Intent.read)
        # Restriction EFFECTIVE : ces actions ne sont pas remises à browser-use,
        # le modèle ne peut donc pas les appeler.
        assert "click" in excluded
        assert "input" in excluded
        assert "send_keys" in excluded

    def test_purchase_keeps_what_it_needs(self) -> None:
        excluded = excluded_actions(Intent.purchase)
        assert "click" not in excluded
        assert "input" not in excluded

    def test_javascript_is_never_available(self) -> None:
        # `evaluate` exécute du JS arbitraire : elle contournerait toute
        # restriction posée au niveau de l'interface.
        for intent in Intent:
            assert "evaluate" in excluded_actions(intent)

    def test_filesystem_is_never_available(self) -> None:
        for intent in Intent:
            excluded = excluded_actions(intent)
            assert "write_file" in excluded
            assert "read_file" in excluded
            assert "upload_file" in excluded

    def test_restrictions_widen_as_intent_narrows(self) -> None:
        assert len(excluded_actions(Intent.read)) > len(excluded_actions(Intent.interact))

    def test_renamed_action_is_reported(self) -> None:
        # Une action renommée en amont ferait sauter une restriction en silence.
        # C'est arrivé pendant le développement : ce garde-fou l'a rattrapé.
        stale = verify_action_names({"click", "input"})
        assert "evaluate" in stale
        assert "click" not in stale

    def test_reports_nothing_when_every_action_exists(self) -> None:
        from app.policies import EXCLUDED_ACTIONS

        available = set().union(*EXCLUDED_ACTIONS.values())
        assert verify_action_names(available) == []


class TestPrompt:
    @pytest.mark.parametrize("intent", list(Intent))
    def test_safety_rules_come_first(self, intent: Intent) -> None:
        prompt = build_prompt(intent, "Achète le billet")
        assert prompt.index("CAPTCHA") < prompt.index("Achète le billet")
        assert "authentification à deux facteurs" in prompt
        # Le contenu des pages est une donnée, jamais une instruction.
        assert "DONNÉE" in prompt

    def test_read_prompt_forbids_interaction(self) -> None:
        assert "LECTURE SEULE" in build_prompt(Intent.read, "x")

    def test_purchase_prompt_requires_amount(self) -> None:
        assert "montant exact" in build_prompt(Intent.purchase, "x")


class TestDomains:
    def test_blocks_internal_hosts_by_default(self) -> None:
        policy = DomainPolicy()
        for url in (
            "http://localhost:8080/x",
            "http://127.0.0.1/x",
            "http://169.254.169.254/latest/meta-data",
            "http://192.168.1.10/admin",
            "http://10.0.0.5/",
        ):
            with pytest.raises(DomainBlocked):
                policy.check(url)

    def test_allows_public_hosts(self) -> None:
        DomainPolicy().check("https://exemple.test/page")

    def test_allowlist_excludes_everything_else(self) -> None:
        policy = DomainPolicy(allowed=("exemple.test", "*.vols.test"))
        policy.check("https://exemple.test/a")
        policy.check("https://www.vols.test/b")
        with pytest.raises(DomainBlocked):
            policy.check("https://autre.test/c")

    def test_denylist_wins_over_allowlist(self) -> None:
        policy = DomainPolicy(allowed=("*.test",), prohibited=("interdit.test",))
        with pytest.raises(DomainBlocked):
            policy.check("https://interdit.test/x")

    def test_private_hosts_allowed_only_when_asked(self) -> None:
        DomainPolicy(allow_private_hosts=True).check("http://127.0.0.1:8999/")


class TestHumanIntervention:
    @pytest.mark.parametrize(
        "text",
        [
            "Le site affiche un CAPTCHA",
            "Please complete the reCAPTCHA",
            "Un code de vérification a été envoyé",
            "Enter your one-time code",
            "Two-factor authentication required",
            "Cochez « je ne suis pas un robot »",
            "Open your authenticator app",
        ],
    )
    def test_detects_protections(self, text: str) -> None:
        assert needs_human_intervention(text)

    @pytest.mark.parametrize(
        "text",
        ["Le billet coûte 42 euros", "Vol Paris-Alger vendredi 20h15", ""],
    )
    def test_ignores_ordinary_results(self, text: str) -> None:
        assert not needs_human_intervention(text)


    def test_blocks_ip_bypasses(self) -> None:
        policy = DomainPolicy()
        for url in (
            "http://2130706433/",        # Decimal 127.0.0.1
            "http://0177.0.0.1/",        # Octal bypass
            "http://[::ffff:127.0.0.1]/",# IPv6 mapped
            "http://[::1]/",             # IPv6 localhost
        ):
            with pytest.raises(DomainBlocked, match="IP"):
                policy.check(url)
