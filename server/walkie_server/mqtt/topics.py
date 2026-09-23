"""Pure helpers for MQTT topic names and topic filters."""


def is_valid_topic(topic: str) -> bool:
    """
    Check whether a topic name is valid for PUBLISH (non-empty, no wildcards).

    :param str topic: Topic name to validate
    :return: True if the topic can be published to
    :rtype: bool
    """
    return bool(topic) and "+" not in topic and "#" not in topic and "\x00" not in topic


def is_valid_filter(topic_filter: str) -> bool:
    """
    Check whether a topic filter is valid for SUBSCRIBE.

    ``+`` must occupy a whole level and ``#`` must be the whole last level.

    :param str topic_filter: Topic filter to validate
    :return: True if the filter is well formed
    :rtype: bool
    """
    if not topic_filter or "\x00" in topic_filter:
        return False
    levels = topic_filter.split("/")
    last = len(levels) - 1
    return all(
        (level == "#" and i == last) or level == "+" or ("#" not in level and "+" not in level)
        for i, level in enumerate(levels)
    )


def matches(topic_filter: str, topic: str) -> bool:
    """
    Tell whether a topic name matches a (valid) topic filter.

    :param str topic_filter: Subscription filter, may contain ``+`` and ``#``
    :param str topic: Concrete topic name
    :return: True if ``topic`` is matched by ``topic_filter``
    :rtype: bool
    """
    if topic.startswith("$") and topic_filter[:1] in ("+", "#"):
        return False
    f_levels = topic_filter.split("/")
    t_levels = topic.split("/")
    for i, f in enumerate(f_levels):
        if f == "#":
            return True
        if i >= len(t_levels) or (f != "+" and f != t_levels[i]):
            return False
    return len(f_levels) == len(t_levels)
