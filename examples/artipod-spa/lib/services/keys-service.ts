/** SPA bridge: key custody lives in core; zustand holds serializable snapshots. */
import { KeysService as CoreKeysService, TaskScheduler, type ServiceAdapters } from '@artipod/core/storage';
import { brokerStore } from '../stores/broker';
import { settingsStore } from '../stores/settings';

export { RENEW_TASK } from '@artipod/core/storage';

export class KeysService extends CoreKeysService {
  constructor(adapters: ServiceAdapters, scheduler: TaskScheduler = new TaskScheduler(adapters.now)) {
    super(adapters, scheduler);
    let broker = this.getSnapshot();
    let settings = this.getSettingsSnapshot();
    brokerStore.setState(broker, true);
    settingsStore.setState(settings, true);
    this.subscribe(() => {
      const nextBroker = this.getSnapshot();
      const nextSettings = this.getSettingsSnapshot();
      if (nextBroker !== broker) {
        broker = nextBroker;
        brokerStore.setState(broker, true);
      }
      if (nextSettings !== settings) {
        settings = nextSettings;
        settingsStore.setState(settings, true);
      }
    });
  }
}
