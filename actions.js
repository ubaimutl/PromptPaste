export function readActions(settings) {
    const actions = JSON.parse(settings.get_string('custom-actions'));
    if (!Array.isArray(actions))
        return [];
    return actions.filter(action =>
        typeof action?.id === 'string' &&
        typeof action?.name === 'string' && action.name.trim() &&
        typeof action?.prompt === 'string' && action.prompt.trim());
}

export function writeActions(settings, actions) {
    settings.set_string('custom-actions', JSON.stringify(actions));
}
