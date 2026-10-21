# Retrace

Retrace records the provenance of actions and artifacts. These terms distinguish
GitHub's incoming material from the Retrace events it may produce.

## Language

**GitHub delivery**:
A GitHub webhook payload considered as provenance input to Retrace. A delivery may
produce zero, one, or several sealed Retrace events.
_Avoid_: event (when referring to the whole delivery)

**Delivery attempt**:
One occasion on which Retrace processes an incoming or retained GitHub delivery.
Several attempts may refer to the same delivery without producing additional events.

**Pending delivery**:
A GitHub delivery retained for routing, processing, recovery, or examination. It may
await its first attempt, await retry, or remain for examination after terminal failure;
pending does not imply that it is currently eligible for retry.
