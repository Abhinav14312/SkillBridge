from enum import IntEnum
from typing import Dict, List, Optional, Set, Tuple
import uuid


class ProficiencyLevel(IntEnum):
    NONE = 0
    BEGINNER = 1
    INTERMEDIATE = 2
    ADVANCED = 3
    EXPERT = 4


class Skill:
    def __init__(self, name: str, category: str = "General"):
        self.name = " ".join(name.split()).lower()
        self.category = category.strip().title()

    def __eq__(self, other) -> bool:
        return isinstance(other, Skill) and self.name == other.name

    def __hash__(self) -> int:
        return hash(self.name)


class LearningGoal:
    def __init__(self, skill: Skill, current_level: ProficiencyLevel, target_level: ProficiencyLevel):
        self.skill = skill
        self.current_level = current_level
        self.target_level = target_level


class User:
    def __init__(self, name: str, email: str, bio: str = ""):
        self.user_id = str(uuid.uuid4())[:8]
        self.name = name
        self.email = email
        self.bio = bio
        self._offered_skills: Dict[Skill, ProficiencyLevel] = {}
        self._learning_goals: Dict[Skill, LearningGoal] = {}

    def offer_skill(self, skill: Skill, level: ProficiencyLevel):
        self._offered_skills[skill] = level

    def want_skill(self, skill: Skill, current: ProficiencyLevel, target: ProficiencyLevel):
        self._learning_goals[skill] = LearningGoal(skill, current, target)

    @property
    def offered_skills(self) -> Set[Skill]:
        return set(self._offered_skills)

    @property
    def wanted_skills(self) -> Set[Skill]:
        return set(self._learning_goals)

    def get_offered_level(self, skill: Skill) -> ProficiencyLevel:
        return self._offered_skills.get(skill, ProficiencyLevel.NONE)

    def get_learning_goal(self, skill: Skill) -> Optional[LearningGoal]:
        return self._learning_goals.get(skill)

    def display_info(self):
        print(f"\n--- {self.name} (ID: {self.user_id}) ---")
        print(f"Email: {self.email} | Bio: {self.bio}")
        print("Teaches:")
        if self._offered_skills:
            for s, lvl in self._offered_skills.items():
                print(f"  • {s.name.title()} ({s.category}) - up to {lvl.name}")
        else:
            print("  • None yet")
        print("Wants to learn:")
        if self._learning_goals:
            for s, g in self._learning_goals.items():
                print(f"  • {s.name.title()} ({s.category}): {g.current_level.name} → {g.target_level.name}")
        else:
            print("  • None yet")


class ExchangeMatch:
    """A two-way swap: each side teaches something the other wants."""

    def __init__(self, user_a: User, user_b: User):
        self.match_id = str(uuid.uuid4())[:8]
        self.user_a = user_a
        self.user_b = user_b
        self.a_teaches_b: List[Tuple[Skill, ProficiencyLevel, ProficiencyLevel, LearningGoal]] = []
        self.b_teaches_a: List[Tuple[Skill, ProficiencyLevel, ProficiencyLevel, LearningGoal]] = []
        self.match_score = 0.0
        self._evaluate()

    @staticmethod
    def _collect(teacher: User, learner: User):
        details, score = [], 0.0
        for skill in teacher.offered_skills & learner.wanted_skills:
            t_level = teacher.get_offered_level(skill)
            goal = learner.get_learning_goal(skill)
            if t_level > goal.current_level:
                achieved = min(t_level, goal.target_level)
                details.append((skill, t_level, achieved, goal))
                # Bonus when the teacher can take the learner all the way to their goal
                score += 1.0 + (0.5 if t_level >= goal.target_level else 0.2)
        return details, score

    def _evaluate(self):
        self.a_teaches_b, s1 = self._collect(self.user_a, self.user_b)
        self.b_teaches_a, s2 = self._collect(self.user_b, self.user_a)
        self.match_score = s1 + s2

    def is_reciprocal(self) -> bool:
        return bool(self.a_teaches_b) and bool(self.b_teaches_a)

    def display_summary(self):
        print(f"\n 2-Way Swap with {self.user_b.name} | Score: {self.match_score:.1f}")
        for teacher, learner, details in (
            (self.user_a, self.user_b, self.a_teaches_b),
            (self.user_b, self.user_a, self.b_teaches_a),
        ):
            print(f"  └─ {teacher.name} teaches {learner.name}:")
            for skill, t_lvl, achieved, goal in details:
                status = "reaches goal" if t_lvl >= goal.target_level else "partial progress"
                print(
                    f"      • {skill.name.title()}: {goal.current_level.name} → {achieved.name} "
                    f"({teacher.name} is {t_lvl.name}; {status})"
                )


class SkillExchangeEngine:
    def __init__(self):
        self.users: Dict[str, User] = {}
        self.skills_registry: Dict[str, Skill] = {}

    def register_skill(self, name: str, category: str = "General") -> Skill:
        key = " ".join(name.split()).lower()
        if key not in self.skills_registry:
            self.skills_registry[key] = Skill(key, category)
        return self.skills_registry[key]

    def register_user(self, user: User):
        self.users[user.user_id] = user

    def find_user(self, query: str) -> Optional[User]:
        """Look up by ID or by name (case-insensitive)."""
        query = query.strip()
        if query in self.users:
            return self.users[query]
        for u in self.users.values():
            if u.name.lower() == query.lower():
                return u
        return None

    def find_direct_matches(self, target: User) -> List[ExchangeMatch]:
        matches = []
        for user in self.users.values():
            if user.user_id == target.user_id:
                continue
            m = ExchangeMatch(target, user)
            if m.is_reciprocal():
                matches.append(m)
        return sorted(matches, key=lambda m: m.match_score, reverse=True)

    def find_one_way_mentors(self, target: User):
        """Teachers for target's goals, excluding people already in a 2-way match."""
        mentors = []
        for user in self.users.values():
            if user.user_id == target.user_id:
                continue
            for skill in user.offered_skills & target.wanted_skills:
                t_level = user.get_offered_level(skill)
                goal = target.get_learning_goal(skill)
                if t_level > goal.current_level:
                    mentors.append((user, skill, t_level, goal))
        return sorted(mentors, key=lambda m: m[2], reverse=True)

    def mentors_for_skill(self, skill: Skill) -> List[Tuple[User, ProficiencyLevel]]:
        found = [(u, u.get_offered_level(skill)) for u in self.users.values() if skill in u.offered_skills]
        return sorted(found, key=lambda x: x[1], reverse=True)


# ==========================================
# Demo data (the scenarios from the project idea)
# ==========================================
def load_demo_data(engine: SkillExchangeEngine):
    E, A, I, B, N = (ProficiencyLevel.EXPERT, ProficiencyLevel.ADVANCED,
                     ProficiencyLevel.INTERMEDIATE, ProficiencyLevel.BEGINNER, ProficiencyLevel.NONE)
    py = engine.register_skill("Python", "Technology")
    guitar = engine.register_skill("Guitar", "Arts")
    finance = engine.register_skill("Finance", "Business")

    def make(name, teaches, learns):
        u = User(name, f"{name.lower()}@example.com", f"I am {name}")
        for skill, lvl in teaches:
            u.offer_skill(skill, lvl)
        for skill, cur, tgt in learns:
            u.want_skill(skill, cur, tgt)
        engine.register_user(u)

    # Perfect swap: expert Python <-> expert Guitar
    make("Abhinav", [(py, E)], [(guitar, N, A)])
    make("Shailaja", [(guitar, E)], [(py, N, E)])
    # Ramakrishna teaches Finance, wants Python + Guitar
    make("Ramakrishna", [(finance, E)], [(py, B, A), (guitar, N, I)])
    # Charlie wants Finance, teaches Guitar -> 2-way match with Ramakrishna
    make("Charlie", [(guitar, I)], [(finance, N, I)])
    # Priya: partial progression example (teaches Python at intermediate only)
    make("Priya", [(py, I)], [(finance, N, A)])


# ==========================================
# CLI helpers
# ==========================================
def ask_level(title: str, options: List[ProficiencyLevel], default: ProficiencyLevel) -> ProficiencyLevel:
    """Keeps asking until the answer is valid, so nothing typed earlier is lost."""
    print(f"\n{title}")
    for lvl in options:
        print(f"  {int(lvl)}. {lvl.name.title()}")
    valid = {int(o): o for o in options}
    while True:
        raw = input(f"Select {int(options[0])}-{int(options[-1])} [default {int(default)}]: ").strip()
        if raw == "":
            return default
        if raw.isdigit() and int(raw) in valid:
            return valid[int(raw)]
        print(" Please pick one of the listed numbers.")


def pick_skill(engine: SkillExchangeEngine) -> Optional[Skill]:
    if engine.skills_registry:
        print("\nSkills already on SkillBridge: " + ", ".join(n.title() for n in sorted(engine.skills_registry)))
    name = input("Skill name (choose from above or type a new one): ").strip()
    if not name:
        return None
    key = " ".join(name.split()).lower()
    if key in engine.skills_registry:
        return engine.skills_registry[key]
    category = input(f"'{name}' is new. Category (e.g. Technology, Arts) [General]: ").strip() or "General"
    return engine.register_skill(name, category)


def add_skills_flow(engine: SkillExchangeEngine, user: User):
    all_levels = list(ProficiencyLevel)
    while True:
        kind = input("\nDo you want to (T)each or (L)earn a skill? [T/L]: ").strip().upper()
        if kind not in ("T", "L"):
            print(" Please enter T or L.")
            continue

        skill = pick_skill(engine)
        if not skill:
            print(" Skill name cannot be empty.")
            continue

        if kind == "T":
            level = ask_level(
                f"How well can you TEACH {skill.name.title()}?",
                all_levels[1:], ProficiencyLevel.INTERMEDIATE,
            )
            user.offer_skill(skill, level)
            print(f" Added: you teach {skill.name.title()} up to {level.name}")
        else:
            current = ask_level(
                f"Where are you NOW in {skill.name.title()}? (0 = never touched it)",
                all_levels[:-1], ProficiencyLevel.NONE,
            )
            targets = [l for l in all_levels if l > current]
            target = ask_level(
                f"Where do you want to GET TO in {skill.name.title()}?",
                targets, targets[-1],
            )
            user.want_skill(skill, current, target)
            print(f" Added: you want to learn {skill.name.title()} ({current.name} → {target.name})")

        if input("\nAdd another skill? [y/N]: ").strip().lower() != "y":
            break


def show_matches(engine: SkillExchangeEngine, user: User):
    print(f"\nScanning matches for {user.name}...")
    direct = engine.find_direct_matches(user)
    swap_ids = {m.user_b.user_id for m in direct}

    if direct:
        print("\n=== 2-WAY SWAPS (you teach each other) ===")
        for m in direct:
            m.display_summary()

    mentors = [m for m in engine.find_one_way_mentors(user) if m[0].user_id not in swap_ids]
    if mentors:
        print(f"\n=== OTHER MENTORS FOR {user.name.upper()} (one-way, no swap yet) ===")
        for mentor, skill, t_lvl, goal in mentors:
            achieved = min(t_lvl, goal.target_level)
            print(f"  • {mentor.name} ({t_lvl.name}) can take you in {skill.name.title()}: "
                  f"{goal.current_level.name} → {achieved.name}")

    if not direct and not mentors:
        print(" No matches yet.")
        for goal in user._learning_goals.values():
            print(f"   Nobody teaches {goal.skill.name.title()} above {goal.current_level.name} right now.")
        print("   Tip: add more skills you can teach so others have a reason to swap with you.")


def main():
    engine = SkillExchangeEngine()
    print("=========================================")
    print("  WELCOME TO SKILLBRIDGE ENGINE (v2.2)  ")
    print("=========================================")

    while True:
        print("\n--- Main Menu ---")
        print("1. Create New User Profile")
        print("2. Add Skills to a User")
        print("3. View User Profile")
        print("4. Find Matches for a User")
        print("5. List All Users")
        print("6. Browse Mentors for a Skill")
        print("7. Load Demo Data")
        print("8. Exit")
        choice = input("\nEnter choice (1-8): ").strip()

        if choice == "1":
            name = input("Enter user's name: ").strip()
            email = input("Enter email: ").strip()
            bio = input("Enter short bio: ").strip()
            if name and email:
                u = User(name, email, bio)
                engine.register_user(u)
                print(f" Registered {name} with ID: {u.user_id}")
            else:
                print(" Name and email are required.")

        elif choice == "2":
            user = engine.find_user(input("Enter User ID or name: "))
            if not user:
                print(" User not found.")
                continue
            print(f"\nAdding skills for: {user.name}")
            add_skills_flow(engine, user)

        elif choice == "3":
            user = engine.find_user(input("Enter User ID or name: "))
            user.display_info() if user else print(" User not found.")

        elif choice == "4":
            user = engine.find_user(input("Enter User ID or name: "))
            show_matches(engine, user) if user else print(" User not found.")

        elif choice == "5":
            if not engine.users:
                print(" No users registered.")
            for u in engine.users.values():
                print(f"• {u.user_id} | {u.name} ({u.email})")

        elif choice == "6":
            skill = engine.skills_registry.get(
                " ".join(input("Skill to search for: ").split()).lower()
            )
            if not skill:
                print(" Nobody has registered that skill yet.")
                continue
            mentors = engine.mentors_for_skill(skill)
            if not mentors:
                print(f" Nobody teaches {skill.name.title()} yet.")
            for u, lvl in mentors:
                print(f"  • {u.name}: {lvl.name}")

        elif choice == "7":
            load_demo_data(engine)
            print(" Demo users loaded: Abhinav, Shailaja, Ramakrishna, Charlie, Priya")

        elif choice == "8":
            print("\nExiting SkillBridge. Goodbye!")
            break
        else:
            print(" Invalid menu option.")


if __name__ == "__main__":
    main()