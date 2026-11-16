//! Child-process lifecycle (spec 7.2 / 10 节超时约束 / T-18).
//!
//! Every sidecar is spawned into a Windows Job Object configured with
//! `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, so a hard kill of the host (or of the
//! adapter) reaps the whole tree — no orphan `python.exe` / `qjs-runner.exe`.
//! Timeouts are wall-clock and process-level: on expiry the child is killed,
//! never merely "cancelled at the future level".

use crate::error::{code, AppError};
use std::process::Stdio;
use std::time::Duration;
use tokio::process::{Child, Command};

/// Hard cap for adapter calls; overridable for tests.
pub const DEFAULT_CALL_TIMEOUT: Duration = Duration::from_secs(15);

/// Windows `CREATE_NO_WINDOW`: the host is a GUI-subsystem binary
/// (`windows_subsystem = "windows"`), while python/qjs sidecars are
/// console-subsystem executables. Without this flag every adapter call makes
/// Windows allocate a new conhost window for the child, flashing a black
/// console in front of the app. Stdio stays piped, so this does not affect
/// the JSON-over-stdout protocol.
#[cfg(windows)]
pub(crate) const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub fn call_timeout() -> Duration {
    crate::env::get("CALL_TIMEOUT_MS")
        .and_then(|value| value.parse::<u64>().ok())
        .map(Duration::from_millis)
        .unwrap_or(DEFAULT_CALL_TIMEOUT)
}

/// A child process plus the job object that guarantees it dies with us.
pub struct Guarded {
    child: Child,
    #[cfg(windows)]
    job: Option<JobHandle>,
}

impl Guarded {
    /// Spawn `program args...` inside a fresh job object.
    pub fn spawn(
        program: &str,
        args: &[String],
        cwd: Option<&std::path::Path>,
    ) -> Result<Self, AppError> {
        Self::spawn_with_env(program, args, cwd, &[])
    }

    /// Same as [`Guarded::spawn`], plus extra environment variables.
    ///
    /// Needed because the JSON-RPC wire format is always UTF-8, while a child
    /// runtime may pick its stdio encoding from the OS locale: a Chinese
    /// Windows (cp936) decoded our frames as GBK, which corrupted every
    /// non-ASCII site name and made `config.decrypt` fail at ~8 KiB.
    pub fn spawn_with_env(
        program: &str,
        args: &[String],
        cwd: Option<&std::path::Path>,
        envs: &[(&str, &str)],
    ) -> Result<Self, AppError> {
        let mut command = Command::new(program);
        command
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true);
        for (key, value) in envs {
            command.env(key, value);
        }
        // GUI host -> console sidecar: suppress the child's console window.
        #[cfg(windows)]
        command.creation_flags(CREATE_NO_WINDOW);
        if let Some(dir) = cwd {
            command.current_dir(dir);
        }
        let child = command.spawn().map_err(|err| {
            AppError::new(code::RUNTIME_UNAVAILABLE, format!("spawn {program} failed"))
                .with_cause(err.to_string())
        })?;

        #[cfg(windows)]
        let job = match child.id() {
            Some(pid) => JobHandle::assign(pid),
            None => None,
        };

        Ok(Self {
            child,
            #[cfg(windows)]
            job,
        })
    }

    pub fn id(&self) -> Option<u32> {
        self.child.id()
    }

    pub fn inner_mut(&mut self) -> &mut Child {
        &mut self.child
    }

    pub fn take_stdin(&mut self) -> Option<tokio::process::ChildStdin> {
        self.child.stdin.take()
    }

    pub fn take_stdout(&mut self) -> Option<tokio::process::ChildStdout> {
        self.child.stdout.take()
    }

    /// Kill the process tree immediately (process-level, not thread-level).
    pub async fn kill(&mut self) {
        let _ = self.child.start_kill();
        let _ = self.child.wait().await;
        #[cfg(windows)]
        if let Some(job) = self.job.take() {
            job.terminate();
        }
    }

    pub async fn try_wait(&mut self) -> std::io::Result<Option<std::process::ExitStatus>> {
        self.child.try_wait()
    }
}

impl Drop for Guarded {
    fn drop(&mut self) {
        #[cfg(windows)]
        if let Some(job) = self.job.take() {
            // Closing the handle triggers KILL_ON_JOB_CLOSE for the whole tree.
            job.terminate();
        }
    }
}

#[cfg(windows)]
struct JobHandle(windows::Win32::Foundation::HANDLE);

#[cfg(windows)]
// SAFETY: the handle is owned by this struct and only used through &self.
unsafe impl Send for JobHandle {}
#[cfg(windows)]
unsafe impl Sync for JobHandle {}

#[cfg(windows)]
impl JobHandle {
    fn assign(pid: u32) -> Option<Self> {
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };
        use windows::Win32::System::Threading::{
            OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
        };

        unsafe {
            let job = CreateJobObjectW(None, None).ok()?;
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
            .is_err()
            {
                let _ = CloseHandle(job);
                return None;
            }

            let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid).ok()?;
            let assigned = AssignProcessToJobObject(job, process).is_ok();
            let _ = CloseHandle(process);
            if !assigned {
                let _ = CloseHandle(job);
                return None;
            }
            Some(Self(job))
        }
    }

    fn terminate(&self) {
        use windows::Win32::System::JobObjects::TerminateJobObject;
        unsafe {
            let _ = TerminateJobObject(self.0, 1);
        }
    }
}

#[cfg(windows)]
impl Drop for JobHandle {
    fn drop(&mut self) {
        use windows::Win32::Foundation::CloseHandle;
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

/// Run a command to completion with a wall-clock deadline.
///
/// On timeout the whole job is terminated, so a grandchild that ignores SIGTERM
/// (or a Windows process without a console) cannot survive.
pub async fn run_with_timeout(
    program: &str,
    args: &[String],
    cwd: Option<&std::path::Path>,
    stdin_payload: Option<Vec<u8>>,
    timeout: Duration,
) -> Result<(i32, Vec<u8>), AppError> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let mut guarded = Guarded::spawn(program, args, cwd)?;
    if let Some(payload) = stdin_payload {
        if let Some(mut stdin) = guarded.take_stdin() {
            let _ = stdin.write_all(&payload).await;
            let _ = stdin.shutdown().await;
        }
    }

    let mut stdout = guarded.take_stdout();
    let reader = tokio::spawn(async move {
        let mut buffer = Vec::new();
        if let Some(stream) = stdout.as_mut() {
            let _ = stream.read_to_end(&mut buffer).await;
        }
        buffer
    });

    let outcome = tokio::time::timeout(timeout, guarded.inner_mut().wait()).await;

    match outcome {
        Ok(Ok(status)) => {
            let buffer = reader.await.unwrap_or_default();
            Ok((status.code().unwrap_or(-1), buffer))
        }
        Ok(Err(err)) => {
            reader.abort();
            Err(AppError::new(code::SPIDER_CRASH, "child wait failed").with_cause(err.to_string()))
        }
        Err(_) => {
            guarded.kill().await;
            reader.abort();
            Err(AppError::new(
                code::SITE_TIMEOUT,
                format!("child exceeded {}ms", timeout.as_millis()),
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn times_out_and_kills_child() {
        #[cfg(windows)]
        let (program, args) = (
            "cmd",
            vec!["/c".to_string(), "ping -n 6 127.0.0.1 > nul".to_string()],
        );
        #[cfg(not(windows))]
        let (program, args) = ("sleep", vec!["5".to_string()]);

        let started = std::time::Instant::now();
        let err = run_with_timeout(program, &args, None, None, Duration::from_millis(300))
            .await
            .expect_err("should time out");
        assert_eq!(err.code, code::SITE_TIMEOUT);
        assert!(started.elapsed() < Duration::from_secs(3), "kill must be prompt");
    }

    #[tokio::test]
    async fn finishes_before_deadline() {
        #[cfg(windows)]
        let (program, args) = ("cmd", vec!["/c".to_string(), "exit 3".to_string()]);
        #[cfg(not(windows))]
        let (program, args) = ("sh", vec!["-c".to_string(), "exit 3".to_string()]);

        let (code_value, _) = run_with_timeout(program, &args, None, None, Duration::from_secs(5))
            .await
            .expect("should finish");
        assert_eq!(code_value, 3);
    }

    #[test]
    fn timeout_env_override_is_honoured() {
        crate::env::set("CALL_TIMEOUT_MS", "2500");
        assert_eq!(call_timeout(), Duration::from_millis(2500));
        std::env::remove_var("LUMA_CALL_TIMEOUT_MS");
    }
}
