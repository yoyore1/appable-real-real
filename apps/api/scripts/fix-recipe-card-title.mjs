import { readProjectFile, writeProjectFile } from "../src/orchestrator.ts";

const pid = process.env.PROJECT_ID ?? "cmq8w9jk20001tlp0m4sbhx2m";
let src = await readProjectFile(pid, "src/components/RecipeCard.tsx");

const broken = `export const RecipeCard: React.FC<RecipeCardProps> = ({ recipe, onToggleFavorite }) => {
  // Special case for recipe-card-1: make "aghetti" red
  const renderTitle = () => {
    if (recipe.id === '1' && recipe.title.includes('aghetti')) {
      const parts = recipe.title.split('aghetti');
      return (
        <>
          <Text>{parts[0]}</Text>
          <Text style={{ color: '#e61919' }}>aghetti</Text>
          {parts[1] ? <Text>{parts[1]}</Text> : null}
        </>
      );
    }
    return <Text>{recipe.title}</Text>;
  };

  return (
    <View style={styles.card} testID={\`recipe-card-\${recipe.id}\`}>
      <Text style={styles.image}>{recipe.image}</Text>
      <View style={styles.content}>
        <Text style={styles.title} testID={\`recipe-title-\${recipe.id}\`}>{renderTitle()}</Text>`;

const fixed = `export const RecipeCard: React.FC<RecipeCardProps> = ({ recipe, onToggleFavorite }) => {
  return (
    <View style={styles.card} testID={\`recipe-card-\${recipe.id}\`}>
      <Text style={styles.image} testID={\`recipe-image-\${recipe.id}\`}>{recipe.image}</Text>
      <View style={styles.content}>
        <Text style={styles.title} testID={\`recipe-title-\${recipe.id}\`}>{recipe.title}</Text>`;

if (src.includes("renderTitle")) {
  src = src.replace(broken, fixed);
  await writeProjectFile(pid, "src/components/RecipeCard.tsx", src);
  console.log("RecipeCard: restored single title Text");
} else if (!src.includes("recipe-image-")) {
  src = src.replace(
    `<Text style={styles.image}>{recipe.image}</Text>`,
    `<Text style={styles.image} testID={\`recipe-image-\${recipe.id}\`}>{recipe.image}</Text>`,
  );
  await writeProjectFile(pid, "src/components/RecipeCard.tsx", src);
  console.log("RecipeCard: already fixed; added image testID");
} else {
  console.log("RecipeCard: already using single title");
}
