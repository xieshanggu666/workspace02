import { User } from './user.entity';
import { Speaker } from './speaker.entity';
import { AudioAsset } from './audio-asset.entity';
import { Course, CourseItem } from './course.entity';
import { PracticeAttempt, Annotation } from './practice.entity';

export const ALL_ENTITIES = [User, Speaker, AudioAsset, Course, CourseItem, PracticeAttempt, Annotation];
export { User, Speaker, AudioAsset, Course, CourseItem, PracticeAttempt, Annotation };
