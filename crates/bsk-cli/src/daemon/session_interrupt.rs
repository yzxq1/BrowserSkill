//! Persistent per-session pause. Only an extension-confirmed explicit resume
//! may clear it; every interrupt advances a generation to invalidate old resumes.
use std::collections::HashMap;
use std::sync::Mutex;
use super::sessions::SessionId;

#[derive(Debug, Default)]
struct State { next: u64, paused: HashMap<SessionId, u64> }
#[derive(Debug, Default)]
pub struct SessionInterruptRegistry { inner: Mutex<State> }
impl SessionInterruptRegistry {
    pub fn new() -> Self { Self::default() }
    pub fn mark(&self, sid: &SessionId) {
        let mut state = self.inner.lock().expect("session_interrupt poisoned");
        state.next = state.next.checked_add(1).expect("interrupt generation exhausted");
        let generation = state.next;
        state.paused.insert(sid.clone(), generation);
    }
    pub fn generation(&self, sid: &SessionId) -> Option<u64> {
        self.inner.lock().expect("session_interrupt poisoned").paused.get(sid).copied()
    }
    pub fn is_pending(&self, sid: &SessionId) -> bool { self.generation(sid).is_some() }
    /// Compare-and-clear after the extension confirms resume. A newer interrupt wins.
    pub fn clear_if_generation(&self, sid: &SessionId, generation: Option<u64>) -> bool {
        let mut state = self.inner.lock().expect("session_interrupt poisoned");
        if state.paused.get(sid).copied() != generation { return false; }
        state.paused.remove(sid);
        true
    }
    pub fn drop_session(&self, sid: &SessionId) {
        self.inner.lock().expect("session_interrupt poisoned").paused.remove(sid);
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn sid(s: &str) -> SessionId { SessionId(s.into()) }
    #[test] fn pause_is_persistent_until_explicit_resume() {
        let reg = SessionInterruptRegistry::new(); let a = sid("A");
        assert!(!reg.is_pending(&a)); reg.mark(&a);
        for _ in 0..10 { assert!(reg.is_pending(&a)); }
        assert!(reg.clear_if_generation(&a, reg.generation(&a)));
        assert!(!reg.is_pending(&a));
    }
    #[test] fn newer_interrupt_invalidates_resume() {
        let reg = SessionInterruptRegistry::new(); let a = sid("A");
        reg.mark(&a); let generation = reg.generation(&a); reg.mark(&a);
        assert!(!reg.clear_if_generation(&a, generation)); assert!(reg.is_pending(&a));
    }
    #[test] fn idempotent_resume_still_detects_new_interrupt() {
        let reg = SessionInterruptRegistry::new(); let a = sid("A");
        assert!(reg.clear_if_generation(&a, None)); reg.mark(&a);
        assert!(!reg.clear_if_generation(&a, None));
    }
    #[test] fn teardown_does_not_allow_generation_reuse() {
        let reg = SessionInterruptRegistry::new(); let a = sid("A");
        reg.mark(&a); let old = reg.generation(&a); reg.drop_session(&a); reg.mark(&a);
        assert!(!reg.clear_if_generation(&a, old));
    }
    #[test] fn sessions_are_independent() {
        let reg = SessionInterruptRegistry::new(); let a = sid("A"); let b = sid("B");
        reg.mark(&a); reg.mark(&b); reg.drop_session(&a);
        assert!(!reg.is_pending(&a)); assert!(reg.is_pending(&b));
    }
}
