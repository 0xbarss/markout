use serde::{de::Error, Deserialize, Deserializer};

/// Timestamps at or above this magnitude are assumed to be milliseconds/microseconds/nanoseconds.
const MILLIS_THRESHOLD: i64 = 100_000_000_000;
const MICROS_THRESHOLD: i64 = 100_000_000_000_000;
const NANOS_THRESHOLD: i64 = 100_000_000_000_000_000;

/// Convert a possibly millisecond, microsecond, or nanosecond Unix timestamp to seconds.
pub fn normalize_time(t: i64) -> i64 {
    if t.abs() >= NANOS_THRESHOLD {
        t / 1_000_000_000
    } else if t.abs() >= MICROS_THRESHOLD {
        t / 1_000_000
    } else if t.abs() >= MILLIS_THRESHOLD {
        t / 1000
    } else {
        t
    }
}

/// Accepts integer seconds/ms/us/ns, fractional seconds, and RFC 3339 strings.
pub fn parse_time_str(s: &str) -> Option<i64> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    if let Ok(i) = s.parse::<i64>() {
        return Some(normalize_time(i));
    }
    if let Ok(f) = s.parse::<f64>() {
        if f.is_finite() {
            return Some(normalize_time(f as i64));
        }
    }
    chrono::DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|d| d.timestamp())
}

pub fn de_time<'de, D: Deserializer<'de>>(d: D) -> Result<i64, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum T {
        I(i64),
        F(f64),
        S(String),
    }
    match T::deserialize(d)? {
        T::I(i) => Ok(normalize_time(i)),
        T::F(f) if f.is_finite() => Ok(normalize_time(f as i64)),
        T::F(_) => Err(D::Error::custom("non-finite timestamp")),
        T::S(s) => {
            parse_time_str(&s).ok_or_else(|| D::Error::custom(format!("unparseable time `{s}`")))
        }
    }
}

pub fn de_opt_time<'de, D: Deserializer<'de>>(d: D) -> Result<Option<i64>, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum T {
        I(i64),
        F(f64),
        S(String),
    }
    match Option::<T>::deserialize(d)? {
        None => Ok(None),
        Some(T::I(i)) => Ok(Some(normalize_time(i))),
        Some(T::F(f)) if f.is_finite() => Ok(Some(normalize_time(f as i64))),
        Some(T::F(_)) => Err(D::Error::custom("non-finite timestamp")),
        Some(T::S(s)) => {
            let s = s.trim();
            if s.is_empty() {
                Ok(None)
            } else {
                parse_time_str(s)
                    .map(Some)
                    .ok_or_else(|| D::Error::custom(format!("unparseable time `{s}`")))
            }
        }
    }
}

pub fn de_opt_id<'de, D: Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum IdVal {
        I(i64),
        U(u64),
        S(String),
    }
    match Option::<IdVal>::deserialize(d)? {
        None => Ok(None),
        Some(IdVal::I(i)) => Ok(Some(i.to_string())),
        Some(IdVal::U(u)) => Ok(Some(u.to_string())),
        Some(IdVal::S(s)) => {
            let s = s.trim();
            if s.is_empty() {
                Ok(None)
            } else {
                Ok(Some(s.to_string()))
            }
        }
    }
}
