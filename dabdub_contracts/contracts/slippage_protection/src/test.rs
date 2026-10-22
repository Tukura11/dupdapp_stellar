#![cfg(test)]

use crate::{SlippageProtectionContract, SlippageProtectionContractClient};
use soroban_sdk::{testutils::Address as _, Address, Env, Symbol};

fn setup_env() -> (Env, SlippageProtectionContractClient<'static>, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let contract_id = env.register(SlippageProtectionContract, (&admin,));
    let client = SlippageProtectionContractClient::new(&env, &contract_id);

    (env, client, admin)
}

// ── constructor ──────────────────────────────────────────────────────────────

#[test]
fn test_constructor_defaults() {
    let (_env, client, admin) = setup_env();
    assert_eq!(client.get_max_slippage(), 100);
    assert_eq!(client.get_admin(), admin);
}

// ── check_slippage: happy paths ──────────────────────────────────────────────

#[test]
fn test_check_slippage_exact_boundary_passes() {
    // deviation == max_bps (100 bps = 1%) → should NOT revert
    let (_env, client, _admin) = setup_env();
    // actual is exactly 1% below expected: 10_000 → 9_900
    client.check_slippage(&10_000, &9_900);
}

#[test]
fn test_check_slippage_within_tolerance_passes() {
    let (_env, client, _admin) = setup_env();
    // 0.5% deviation — well within 1%
    client.check_slippage(&10_000, &9_950);
}

#[test]
fn test_check_slippage_zero_deviation_passes() {
    let (_env, client, _admin) = setup_env();
    client.check_slippage(&10_000, &10_000);
}

// ── check_slippage: revert paths ─────────────────────────────────────────────

#[test]
#[should_panic(expected = "SlippageExceeded")]
fn test_check_slippage_one_bps_over_reverts() {
    // deviation == 101 bps → must revert
    let (_env, client, _admin) = setup_env();
    // 101 bps below: 10_000 → 9_899
    client.check_slippage(&10_000, &9_899);
}

#[test]
#[should_panic(expected = "SlippageExceeded")]
fn test_check_slippage_large_deviation_reverts() {
    let (_env, client, _admin) = setup_env();
    client.check_slippage(&10_000, &5_000); // 50% deviation
}

#[test]
#[should_panic(expected = "expected must be > 0")]
fn test_check_slippage_zero_expected_reverts() {
    let (_env, client, _admin) = setup_env();
    client.check_slippage(&0, &100);
}

// ── set_max_slippage ─────────────────────────────────────────────────────────

#[test]
fn test_admin_can_tighten_slippage() {
    let (_env, client, admin) = setup_env();
    client.set_max_slippage(&admin, &50); // tighten to 0.5%
    assert_eq!(client.get_max_slippage(), 50);
}

#[test]
fn test_admin_can_relax_slippage() {
    let (_env, client, admin) = setup_env();
    client.set_max_slippage(&admin, &300); // relax to 3%
    assert_eq!(client.get_max_slippage(), 300);
}

#[test]
#[should_panic(expected = "bps must be <= 10000")]
fn test_admin_cannot_set_slippage_above_bps_denominator() {
    let (_env, client, admin) = setup_env();
    client.set_max_slippage(&admin, &10_001);
}

#[test]
fn test_tightened_slippage_rejects_previously_valid_swap() {
    let (_env, client, admin) = setup_env();
    // 0.8% deviation passes at default 1%
    client.check_slippage(&10_000, &9_920);
    // tighten to 0.5%
    client.set_max_slippage(&admin, &50);
    // now same deviation should revert — tested separately below
    assert_eq!(client.get_max_slippage(), 50);
}

#[test]
#[should_panic(expected = "SlippageExceeded")]
fn test_tightened_slippage_reverts_swap() {
    let (_env, client, admin) = setup_env();
    client.set_max_slippage(&admin, &50); // 0.5%
                                          // 0.8% deviation → should now revert
    client.check_slippage(&10_000, &9_920);
}

#[test]
#[should_panic(expected = "Not admin")]
fn test_non_admin_cannot_set_slippage() {
    let (env, client, _admin) = setup_env();
    let random = Address::generate(&env);
    client.set_max_slippage(&random, &200);
}

#[test]
#[should_panic(expected = "bps must be <= 10000")]
fn test_set_max_slippage_rejects_out_of_range_bps() {
    let (_env, client, admin) = setup_env();
    client.set_max_slippage(&admin, &10_001);
}

// ── per-pair slippage: XLM/USDC and USDC/NGN ─────────────────────────────────

fn xlm_usdc(env: &Env) -> Symbol {
    Symbol::new(env, "XLM_USDC")
}

fn usdc_ngn(env: &Env) -> Symbol {
    Symbol::new(env, "USDC_NGN")
}

#[test]
fn test_pair_falls_back_to_global_max() {
    let (env, client, _admin) = setup_env();
    // No per-pair config → global default (100 bps) applies.
    assert_eq!(client.get_pair_max_slippage(&xlm_usdc(&env)), 100);
    assert_eq!(client.get_pair_max_slippage(&usdc_ngn(&env)), 100);

    // 1% deviation passes for both pairs under the global fallback.
    client.check_slippage_for_pair(&xlm_usdc(&env), &10_000, &9_900);
    client.check_slippage_for_pair(&usdc_ngn(&env), &10_000, &9_900);
}

#[test]
fn test_admin_sets_per_pair_slippage() {
    let (env, client, admin) = setup_env();
    client.set_pair_max_slippage(&admin, &xlm_usdc(&env), &30); // 0.3%
    client.set_pair_max_slippage(&admin, &usdc_ngn(&env), &500); // 5%

    assert_eq!(client.get_pair_max_slippage(&xlm_usdc(&env)), 30);
    assert_eq!(client.get_pair_max_slippage(&usdc_ngn(&env)), 500);
    // Global max is untouched by per-pair config.
    assert_eq!(client.get_max_slippage(), 100);
}

#[test]
fn test_xlm_usdc_tighter_than_usdc_ngn() {
    let (env, client, admin) = setup_env();
    client.set_pair_max_slippage(&admin, &xlm_usdc(&env), &30); // 0.3%
    client.set_pair_max_slippage(&admin, &usdc_ngn(&env), &500); // 5%

    // 1% deviation: too loose for XLM/USDC, fine for USDC/NGN.
    client.check_slippage_for_pair(&usdc_ngn(&env), &10_000, &9_900);
}

#[test]
#[should_panic(expected = "SlippageExceeded")]
fn test_xlm_usdc_rejects_one_percent_deviation() {
    let (env, client, admin) = setup_env();
    client.set_pair_max_slippage(&admin, &xlm_usdc(&env), &30); // 0.3%
    // 1% deviation exceeds the tighter XLM/USDC tolerance.
    client.check_slippage_for_pair(&xlm_usdc(&env), &10_000, &9_900);
}

#[test]
fn test_xlm_usdc_within_tighter_tolerance_passes() {
    let (env, client, admin) = setup_env();
    client.set_pair_max_slippage(&admin, &xlm_usdc(&env), &30); // 0.3%
    // 0.2% deviation is within the tighter XLM/USDC tolerance.
    client.check_slippage_for_pair(&xlm_usdc(&env), &10_000, &9_980);
}

#[test]
#[should_panic(expected = "SlippageExceeded")]
fn test_usdc_ngn_rejects_beyond_loose_tolerance() {
    let (env, client, admin) = setup_env();
    client.set_pair_max_slippage(&admin, &usdc_ngn(&env), &500); // 5%
    // 6% deviation exceeds the relaxed USDC/NGN tolerance.
    client.check_slippage_for_pair(&usdc_ngn(&env), &10_000, &9_400);
}

#[test]
#[should_panic(expected = "Not admin")]
fn test_non_admin_cannot_set_pair_slippage() {
    let (env, client, _admin) = setup_env();
    let random = Address::generate(&env);
    client.set_pair_max_slippage(&random, &xlm_usdc(&env), &30);
}

#[test]
#[should_panic(expected = "bps must be <= 10000")]
fn test_set_pair_slippage_rejects_out_of_range_bps() {
    let (env, client, admin) = setup_env();
    client.set_pair_max_slippage(&admin, &xlm_usdc(&env), &10_001);
}
