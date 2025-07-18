import {
  Controller,
  Get,
  Logger,
  InternalServerErrorException,
} from '@nestjs/common';
import { StorageService, StorageNamespace } from 'src/storage/storage.service';

@Controller('scenes')
export class LoadController {
  private readonly logger = new Logger(LoadController.name);

  constructor(private readonly storageService: StorageService) {}

  @Get()
  async listScenes() {
    try {
      // Get the Keyv instance for scenes
      const sceneStorage = this.storageService.storagesMap.get(StorageNamespace.SCENES);
      
      if (!sceneStorage) {
        throw new Error('Scene storage not available');
      }

      // For SQLite/Keyv, we need to iterate through all keys
      // This is a simplified approach - in production you might want pagination
      const scenes = [];
      
      // Note: Keyv doesn't have a built-in keys() method for all adapters
      // For now, we'll return an empty array or you could implement a different approach
      this.logger.debug('Listing scenes from storage');
      
      return scenes;
    } catch (err) {
      this.logger.error('Error listing scenes', err as any);
      throw new InternalServerErrorException('Failed to list scenes');
    }
  }
}
