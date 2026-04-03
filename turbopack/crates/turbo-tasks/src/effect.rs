use std::{any::Any, future::Future, pin::Pin, sync::Arc};

use anyhow::{Result, bail};
use auto_hash_map::AutoSet;
use dashmap::DashMap;
use futures::{StreamExt, TryStreamExt};
use parking_lot::Mutex;
use rustc_hash::FxHashSet;
use tracing::Instrument;

use crate::{
    self as turbo_tasks, CollectiblesSource, NonLocalValue, ReadRef, ResolvedVc, TryJoinIterExt,
    emit, trace::TraceRawVcs,
};

const APPLY_EFFECTS_CONCURRENCY_LIMIT: usize = 1024;

pub trait Effect: TraceRawVcs + NonLocalValue + Send + Sync + 'static {
    /// The type of this effect's value for storage and comparison.
    /// Must be Eq + Send + Sync + 'static so it can be stored in the state map and compared.
    type Value: Eq + Send + Sync + 'static;

    /// Unique key identifying this effect's target (e.g., absolute path bytes).
    fn key(&self) -> Vec<u8>;

    /// Extract the value part of this effect for storage in the state map.
    fn value(&self) -> Self::Value;

    /// Returns a reference to the state storage.
    fn state_storage(&self) -> &EffectStateStorage;

    /// Perform the side effect (write file, create symlink, etc.).
    fn apply(&self) -> impl Future<Output = Result<()>> + Send;
}

/// Per-key entry in the effect state storage.
///
/// - `last_applied`: the value that was last successfully written (sync-readable for fast-path
///   dedup)
/// - `write_lock`: async mutex held during the actual write; ensures only one concurrent write per
///   key
struct EffectStateEntry {
    last_applied: Mutex<Option<Box<dyn Any + Send + Sync>>>,
    write_lock: tokio::sync::Mutex<()>,
}

impl Default for EffectStateEntry {
    fn default() -> Self {
        Self {
            last_applied: Mutex::new(None),
            write_lock: tokio::sync::Mutex::new(()),
        }
    }
}

/// Shared state storage for tracking applied effects. Stored on the filesystem implementation
/// (e.g. DiskFileSystemInner).
#[derive(Default)]
pub struct EffectStateStorage {
    effect_state: DashMap<Vec<u8>, Arc<EffectStateEntry>>,
}

// Private wrapper trait to allow dynamic dispatch of an `Effect`. This is similar to the pattern
// that the dynosaur crate uses: https://github.com/spastorino/dynosaur
trait DynEffect: TraceRawVcs + NonLocalValue + Send + Sync + 'static {
    fn key(&self) -> Vec<u8>;
    fn eq_value_dyn(&self, other: &dyn Any) -> bool;
    fn value_dyn(&self) -> Box<dyn Any + Send + Sync>;
    fn state_storage(&self) -> &EffectStateStorage;
    fn dyn_apply<'a>(&'a self) -> DynEffectApplyFuture<'a>;
}

impl<T> DynEffect for T
where
    T: Effect,
{
    fn key(&self) -> Vec<u8> {
        Effect::key(self)
    }

    fn eq_value_dyn(&self, other: &dyn Any) -> bool {
        match other.downcast_ref::<T::Value>() {
            Some(other_val) => Effect::value(self) == *other_val,
            None => false,
        }
    }

    fn value_dyn(&self) -> Box<dyn Any + Send + Sync> {
        Box::new(Effect::value(self))
    }

    fn state_storage(&self) -> &EffectStateStorage {
        Effect::state_storage(self)
    }

    fn dyn_apply<'a>(&'a self) -> DynEffectApplyFuture<'a> {
        Box::pin(Effect::apply(self))
    }
}

type DynEffectApplyFuture<'a> = Pin<Box<dyn Future<Output = Result<()>> + Send + 'a>>;

/// A trait to emit a task effect as collectible. This trait only has one implementation,
/// `EffectInstance` and no other implementation is allowed. The trait is private to this module so
/// that no other implementation can be added.
#[turbo_tasks::value_trait]
trait EffectCollectible {}

/// The Effect instance collectible that is emitted for effects.
#[turbo_tasks::value(serialization = "none", cell = "new", eq = "manual")]
struct EffectInstance {
    #[turbo_tasks(debug_ignore)]
    inner: Box<dyn DynEffect>,
}

impl EffectInstance {
    fn new(effect: impl Effect) -> Self {
        Self {
            inner: Box::new(effect) as Box<dyn DynEffect>,
        }
    }
}

#[turbo_tasks::value_impl]
impl EffectCollectible for EffectInstance {}

/// Emits an effect to be applied. The effect is executed once `apply_effects` is called.
///
/// The effect will only executed once. The effect is executed outside of the current task
/// and can't read any Vcs. These need to be read before. ReadRefs can be passed into the effect.
///
/// Effects are executed in parallel, so they might need to use async locking to avoid problems.
/// Order of execution of multiple effects is not defined. You must not use multiple conflicting
/// effects to avoid non-deterministic behavior.
pub fn emit_effect(effect: impl Effect) {
    emit::<Box<dyn EffectCollectible>>(ResolvedVc::upcast(
        EffectInstance::new(effect).resolved_cell(),
    ));
}

/// Applies all effects that have been emitted by an operation.
///
/// Usually it's important that effects are strongly consistent, so one want to use `apply_effects`
/// only on operations that have been strongly consistently read before.
///
/// The order of execution is not defined and effects are executed in parallel.
///
/// `apply_effects` must only be used in a "once" task. When used in a "root" task, a
/// combination of `get_effects` and `Effects::apply` must be used.
///
/// # Example
///
/// ```rust
/// let operation = some_turbo_tasks_function(args);
/// let result = operation.strongly_consistent().await?;
/// apply_effects(operation).await?;
/// ```
pub async fn apply_effects(source: impl CollectiblesSource) -> Result<()> {
    get_effects(source).await?.apply().await
}

/// Capture effects from a turbo-tasks operation. Since this captures collectibles it might
/// invalidate the current task when effects are changing or even temporarily change.
///
/// Therefore it's important to wrap this in a strongly consistent read before applying the effects
/// with `Effects::apply`.
///
/// # Example
///
/// ```rust
/// async fn some_turbo_tasks_function_with_effects(args: Args) -> Result<ResultWithEffects> {
///     let operation = some_turbo_tasks_function(args);
///     let result = operation.strongly_consistent().await?;
///     let effects = get_effects(operation).await?;
///     Ok(ResultWithEffects { result, effects })
/// }
///
/// let result_with_effects = some_turbo_tasks_function_with_effects(args).strongly_consistent().await?;
/// result_with_effects.effects.apply().await?;
/// ```
pub async fn get_effects(source: impl CollectiblesSource) -> Result<Effects> {
    let effects: AutoSet<ResolvedVc<Box<dyn EffectCollectible>>> = source.take_collectibles();
    let effects = effects
        .into_iter()
        .map(|effect| async move {
            if let Some(effect) = ResolvedVc::try_downcast_type::<EffectInstance>(effect) {
                Ok(effect.await?)
            } else {
                panic!("Effect must only be implemented by EffectInstance");
            }
        })
        .try_join()
        .await?;
    Ok(Effects { effects })
}

/// Captured effects from an operation. This struct can be used to return Effects from a turbo-tasks
/// function and apply them later.
#[derive(Default)]
#[turbo_tasks::value(shared, eq = "manual", serialization = "none")]
pub struct Effects {
    #[turbo_tasks(debug_ignore)]
    effects: Vec<ReadRef<EffectInstance>>,
}

impl PartialEq for Effects {
    fn eq(&self, other: &Self) -> bool {
        if self.effects.len() != other.effects.len() {
            return false;
        }
        let effect_ptrs = self
            .effects
            .iter()
            .map(ReadRef::ptr)
            .collect::<FxHashSet<_>>();
        other
            .effects
            .iter()
            .all(|e| effect_ptrs.contains(&ReadRef::ptr(e)))
    }
}

impl Eq for Effects {}

impl Effects {
    /// Applies all effects that have been captured.
    ///
    /// This performs:
    /// 1. Grouping by key and conflict/duplicate detection
    /// 2. Comparison against previously applied state (skip if unchanged)
    /// 3. Parallel application of remaining effects
    pub async fn apply(&self) -> Result<()> {
        if self.effects.is_empty() {
            return Ok(());
        }
        let span = tracing::info_span!("apply effects", count = self.effects.len());

        async {
            // Step 1: Group effects by key and detect duplicates/conflicts
            let mut by_key: rustc_hash::FxHashMap<Vec<u8>, Vec<&dyn DynEffect>> =
                rustc_hash::FxHashMap::default();
            for effect in &self.effects {
                let key = effect.inner.key();
                by_key.entry(key).or_default().push(&*effect.inner);
            }

            // Step 2: Deduplicate and detect conflicts
            let mut unique_effects: Vec<&dyn DynEffect> = Vec::with_capacity(by_key.len());
            for (key, effects) in &by_key {
                if effects.len() > 1 {
                    // Check all effects in this group are equal
                    let first_value = effects[0].value_dyn();
                    for other in &effects[1..] {
                        if !other.eq_value_dyn(&*first_value) {
                            bail!(
                                "Conflicting effects for the same key (key length: {} bytes)",
                                key.len()
                            );
                        }
                    }
                }
                // Keep one representative effect per key
                unique_effects.push(effects[0]);
            }

            // Step 3: Apply effects in parallel
            futures::stream::iter(unique_effects)
                .map(Ok)
                .try_for_each_concurrent(APPLY_EFFECTS_CONCURRENCY_LIMIT, async |effect| {
                    let key = effect.key();
                    let state_storage = effect.state_storage();

                    // Get or insert per-key entry (fast sync path)
                    let entry = state_storage
                        .effect_state
                        .entry(key)
                        .or_insert_with(|| Arc::new(EffectStateEntry::default()))
                        .clone();

                    // Fast path: check if the stored value already matches (sync, no await)
                    {
                        let stored = entry.last_applied.lock();
                        if let Some(stored_val) = stored.as_ref()
                            && effect.eq_value_dyn(&**stored_val)
                        {
                            return Ok(());
                        }
                    }

                    // Slow path: acquire the write lock and re-check before writing
                    let _write_guard = entry.write_lock.lock().await;

                    {
                        let stored = entry.last_applied.lock();
                        if let Some(stored_val) = stored.as_ref()
                            && effect.eq_value_dyn(&**stored_val)
                        {
                            return Ok(());
                        }
                    }

                    // Clear stored value so concurrent fast-path checks won't
                    // match against the stale value while we're writing.
                    *entry.last_applied.lock() = None;

                    // Apply the effect
                    effect.dyn_apply().await?;

                    // Store the new value (sync)
                    *entry.last_applied.lock() = Some(effect.value_dyn());

                    Ok(())
                })
                .await
        }
        .instrument(span)
        .await
    }
}

#[cfg(test)]
mod tests {
    use crate::{CollectiblesSource, apply_effects, get_effects};

    #[test]
    #[allow(dead_code)]
    fn is_send() {
        fn assert_send<T: Send>(_: T) {}
        fn check_apply_effects<T: CollectiblesSource + Send + Sync>(t: T) {
            assert_send(apply_effects(t));
        }
        fn check_get_effects<T: CollectiblesSource + Send + Sync>(t: T) {
            assert_send(get_effects(t));
        }
    }
}
