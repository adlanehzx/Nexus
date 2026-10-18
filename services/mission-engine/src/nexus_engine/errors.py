class MissionControlError(Exception):
    """Base class for domain errors."""


class ValidationError(MissionControlError):
    """The submitted plan is structurally or semantically invalid."""


class ConflictError(MissionControlError):
    """An idempotency key was reused with different input."""


class LeaseLostError(MissionControlError):
    """A worker attempted to write after losing its fencing lease."""


class NotFoundError(MissionControlError):
    """A requested aggregate does not exist."""
